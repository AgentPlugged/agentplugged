import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  AGENT_DOMAINS,
  activeAgents,
  type Definition,
  DOMAIN_IDS,
  readDefinitions,
  renderConstitution,
  resolveProfile,
} from "@agentplugged/core";
import { sha256Hex } from "@agentplugged/crypto";
import type { AgentFrontmatter } from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { noahCorpus } from "./__helpers__/noah-text.js";
import { SHARED_RULES_POINTER, sharedRules } from "./__helpers__/shared-rules.js";

/** The shipped method: the `@agentplugged/method` package of the monorepo. */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const flat = (text: string) => text.replace(/\s+/g, " ");

/**
 * The team: product and design, then build, quality, delivery and growth,
 * renamed with the developers by specialty.
 */
const TEAM = {
  iris: {
    name: "Iris",
    title: "Product Analyst",
    domain: "product",
    phase: "framing",
    risk: "low",
    tier: "reasoning",
  },
  maya: {
    name: "Maya",
    title: "Product Manager",
    domain: "product",
    phase: "planning",
    risk: "medium",
    tier: "reasoning",
  },
  stella: {
    name: "Stella",
    title: "Product UX Designer",
    domain: "ux",
    phase: "planning",
    risk: "low",
    tier: "multimodal",
  },
  alex: {
    name: "Alex",
    title: "Architect",
    domain: "architecture",
    phase: "design",
    risk: "high",
    tier: "reasoning",
  },
  izzy: {
    name: "Izzy",
    title: "Scrum Master",
    domain: "product",
    phase: "build",
    risk: "medium",
    tier: "fast",
  },
  basile: {
    name: "Basile",
    title: "Devil's Advocate",
    domain: "product",
    phase: "planning",
    risk: "low",
    tier: "reasoning",
  },
  // Build, quality, delivery and growth.
  sam: {
    name: "Sam",
    title: "Backend Developer",
    domain: "code",
    phase: "build",
    risk: "medium",
    tier: "code",
  },
  ethan: {
    name: "Ethan",
    title: "Backend Developer",
    domain: "code",
    phase: "build",
    risk: "medium",
    tier: "code",
  },
  hugo: {
    name: "Hugo",
    title: "Frontend Developer",
    domain: "code",
    phase: "build",
    risk: "medium",
    tier: "code",
  },
  lina: {
    name: "Lina",
    title: "Frontend Developer",
    domain: "code",
    phase: "build",
    risk: "medium",
    tier: "code",
  },
  jade: {
    name: "Jade",
    title: "Mobile Developer",
    domain: "code",
    phase: "build",
    risk: "medium",
    tier: "code",
  },
  quentin: {
    name: "Quentin",
    title: "QA Reviewer",
    domain: "quality",
    phase: "build",
    risk: "low",
    tier: "reasoning",
  },
  tess: {
    name: "Tess",
    title: "Test Architect",
    domain: "quality",
    phase: "design",
    risk: "low",
    tier: "reasoning",
  },
  chloe: {
    name: "Chloé",
    title: "Security Reviewer",
    domain: "security",
    phase: "build",
    risk: "high",
    tier: "reasoning",
  },
  omar: {
    name: "Omar",
    title: "Delivery Engineer",
    domain: "delivery",
    phase: "delivery",
    risk: "high",
    tier: "code",
  },
  zoe: {
    name: "Zoé",
    title: "Documentation Writer",
    domain: "docs",
    phase: "build",
    risk: "low",
    tier: "fast",
  },
  lou: {
    name: "Lou",
    title: "Creative Facilitator",
    domain: "creativity",
    phase: "framing",
    risk: "low",
    tier: "reasoning",
  },
  julien: {
    name: "Julien",
    title: "Launch, Marketing & SEO",
    domain: "marketing",
    phase: "launch",
    risk: "medium",
    tier: "multimodal",
  },
  milo: {
    name: "Milo",
    title: "Sales",
    domain: "sales",
    phase: "launch",
    risk: "medium",
    tier: "reasoning",
  },
} as const;

type TeamId = keyof typeof TEAM;
const TEAM_IDS = Object.keys(TEAM) as TeamId[];

/** Agents whose work lives in the code (a story's branch), with no deliverable in `.agentplugged/`. */
const CODE_ONLY: readonly TeamId[] = ["sam", "ethan", "hugo", "lina", "jade"];

/** The developers and their specialty: a field of work, never a language. */
const SPECIALTIES: Readonly<Record<string, string>> = {
  sam: "backend",
  ethan: "backend",
  hugo: "frontend",
  lina: "frontend",
  jade: "mobile",
};

let agents: Map<string, Definition>;

beforeAll(async () => {
  const definitions = await readDefinitions(new NodeWorkspaceFiles(methodDir), "agents", "agent");
  if (!Array.isArray(definitions)) {
    throw new Error(`invalid shipped agent: ${JSON.stringify(definitions.details)}`);
  }
  agents = new Map(definitions.map((definition) => [definition.name, definition]));
});

function agentOf(id: TeamId): Definition {
  const definition = agents.get(id);
  if (definition?.agent === undefined) throw new Error(`${id} is not shipped`);
  return definition;
}

/** The text of a `## <title>` section of a SKILL.md body, up to the next `## ` heading. */
function section(body: string, title: string): string | undefined {
  const lines = body.split("\n");
  const start = lines.indexOf(`## ${title}`);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** The `.agentplugged/` paths a SKILL.md lists as its own deliverables. */
function deliverables(body: string): string[] {
  const text = section(body, "Deliverables") ?? "";
  return [...text.matchAll(/^- `\.agentplugged\/([^`]+)`/gm)].map((match) => match[1] ?? "");
}

describe("the team", () => {
  it("ships the nineteen agents and Noah, and nothing else", () => {
    expect([...agents.keys()].sort()).toEqual([...TEAM_IDS, "noah"].sort());
    // Noah serves every domain: no profile makes him inactive.
    expect(Object.keys(AGENT_DOMAINS).sort()).toEqual([...TEAM_IDS].sort());
  });

  it("gives each developer its specialty, and no other agent one", () => {
    for (const id of TEAM_IDS) {
      const metadata = (agentOf(id).frontmatter as AgentFrontmatter).metadata;
      expect(metadata.specialty, id).toBe(SPECIALTIES[id]);
      // The quick lane is a mode of every developer: a menu item that reads the reference of
      // `develop-story`, no agent nor skill of its own.
      const quick = agentOf(id).agent?.menu.some(
        (item) => item.code === "QL" && (item.prompt ?? "").includes("references/quick-lane.md"),
      );
      expect(quick, id).toBe(SPECIALTIES[id] !== undefined);
    }
  });

  it("gives every domain of the catalog at least one agent", () => {
    const served = new Set(
      [...agents.values()].map((d) => (d.frontmatter as AgentFrontmatter).metadata.domain),
    );
    for (const domain of DOMAIN_IDS) expect(served.has(domain), domain).toBe(true);
  });

  it("keeps the code, quality, security, delivery and docs agents for maintenance", () => {
    const active = activeAgents(resolveProfile("maintenance"));
    // Backend and frontend: Jade waits until the mobile specialty is on.
    expect(TEAM_IDS.filter((id) => active.includes(id)).sort()).toEqual(
      ["chloe", "ethan", "hugo", "lina", "omar", "quentin", "sam", "tess", "zoe"].sort(),
    );
    expect(
      activeAgents(resolveProfile("maintenance", { specialties: ["backend", "mobile"] })),
    ).toEqual(expect.arrayContaining(["sam", "ethan", "jade"]));
  });

  it.each(TEAM_IDS)("ships %s, valid and as the table says", (id) => {
    const expected = TEAM[id];
    const definition = agentOf(id);
    const agent = definition.agent;
    const metadata = (definition.frontmatter as AgentFrontmatter).metadata;
    expect(agent?.name).toBe(expected.name);
    expect(agent?.title).toBe(expected.title);
    expect(metadata).toMatchObject({
      domain: expected.domain,
      phase: expected.phase,
      risk: expected.risk,
      model_tier: expected.tier,
    });
    // The catalog of the profile serves each agent under the same domain.
    expect(AGENT_DOMAINS[id]).toBe(expected.domain);
  });

  it.each(TEAM_IDS)("gives %s a full persona, voice and menu", (id) => {
    const agent = agentOf(id).agent;
    expect(agent?.icon).toBeTruthy();
    expect(agent?.role).toBeTruthy();
    expect(agent?.identity).toBeTruthy();
    expect(agent?.communication_style).toBeTruthy();
    expect(agent?.principles.length).toBeGreaterThanOrEqual(4);
    expect(agent?.principles.length).toBeLessThanOrEqual(7);
    expect(agent?.persistent_facts.length).toBeGreaterThan(0);
    expect(agent?.voice).toMatchObject({
      tone: expect.any(String),
      pace: expect.any(String),
      register: expect.any(String),
    });
    expect(agent?.menu.length).toBeGreaterThanOrEqual(4);
    expect(agent?.menu.length).toBeLessThanOrEqual(9);
    // Every item is a prompt or a skill (the shipped skills are checked in method-skills.test.ts).
    for (const item of agent?.menu ?? []) expect(item.prompt ?? item.skill, item.code).toBeTruthy();
  });

  it.each(TEAM_IDS)("covers overview, deliverables, work and boundaries for %s", (id) => {
    const { body, agent } = agentOf(id);
    // No "Mission" section: the role and the principles of the definition say it, the overview
    // holds what is left of it once.
    const titles = [
      "Overview",
      "Deliverables",
      `How ${agent?.name} works`,
      "Method rules",
      "Boundaries",
    ];
    for (const title of titles) {
      const headings = body.split("\n").filter((line) => line === `## ${title}`);
      expect(headings, `${id}: ## ${title}`).toHaveLength(1);
    }
    // The rules every agent holds to (own folders, reporting, checkpoints, stable
    // identifiers) are the constitution's, written once and read at every request.
    const constitution = flat(renderConstitution());
    for (const rule of [
      "write only in `docs/`, `epics/` and `stories/`",
      "`agent.status`",
      "`state.get`",
      "`story.result`",
      "`checkpoint.open`",
      "never renumbered",
      "`npx agentplugged docs check`",
    ]) {
      expect(constitution, rule).toContain(rule);
    }
    // What a document writer adds: the approval, the retired markers.
    const rules = (section(body, "Method rules") ?? "").replace(/\s+/g, " ");
    if (!CODE_ONLY.includes(id)) {
      for (const rule of ["resolved `approved` in `state.get`", "`EF-2 : (retired) …`"]) {
        if (id === "lou" || id === "julien" || id === "milo") continue;
        expect(rules, `${id}: ${rule}`).toContain(rule);
      }
    }
    // A single role, and no agent orchestrates the others: the boundaries say what the agent is
    // not, hand anything else back to Noah (the creator when he is off), and call nobody.
    const boundaries = (section(body, "Boundaries") ?? "").replace(/\s+/g, " ");
    expect(boundaries).toContain("Never call, direct nor coordinate another agent");
    expect(boundaries).toContain("hand back to Noah");
    expect(boundaries).toContain("to the creator when Noah is off");
    expect(boundaries).not.toContain("the creator chooses who works next");
  });

  it("keeps who owns what in one place: Noah's team reference names every agent", () => {
    const team = flat(noahCorpus(methodDir));
    for (const id of TEAM_IDS) expect(team, id).toContain(TEAM[id].name);
  });

  it("gives every agent its own deliverables, in the folders agents may write", () => {
    const owners = new Map<string, TeamId>();
    for (const id of TEAM_IDS) {
      const paths = deliverables(agentOf(id).body);
      if (CODE_ONLY.includes(id)) expect(paths, id).toEqual([]);
      else expect(paths.length, id).toBeGreaterThan(0);
      for (const path of paths) {
        expect(path, `${id}: ${path}`).toMatch(/^(docs|epics|stories)\//);
        for (const [other, owner] of owners) {
          if (owner === id) continue;
          const overlap =
            other === path ||
            (other.endsWith("/") && path.startsWith(other)) ||
            (path.endsWith("/") && other.startsWith(path));
          expect(overlap, `${path} (${id}) overlaps ${other} (${owner})`).toBe(false);
        }
        owners.set(path, id);
      }
    }
    expect(owners.get("docs/brief.md")).toBe("iris");
    expect(owners.get("docs/prd.md")).toBe("maya");
    expect(owners.get("docs/ux.md")).toBe("stella");
    expect(owners.get("docs/architecture.md")).toBe("alex");
    expect(owners.get("epics/")).toBe("izzy");
    expect(owners.get("stories/")).toBe("izzy");
    expect(owners.get("docs/test-strategy.md")).toBe("tess");
    expect(owners.get("docs/threat-model.md")).toBe("chloe");
    expect(owners.get("docs/runbook.md")).toBe("omar");
    expect(owners.get("docs/index.md")).toBe("zoe");
    for (const path of ["vision.md", "conventions.md", "guides/", "reference/", "release-notes/"]) {
      expect(owners.get(`docs/${path}`), path).toBe("zoe");
    }
    expect(owners.get("docs/qa-reviews/")).toBe("quentin");
    expect(owners.get("docs/drift-report.md")).toBe("quentin");
    expect(owners.get("docs/security-reviews/")).toBe("chloe");
    expect(owners.get("docs/ideas/")).toBe("lou");
    expect(owners.get("docs/contests/")).toBe("basile");
    expect(owners.get("docs/launch/")).toBe("julien");
    expect(owners.get("docs/sales/")).toBe("milo");
  });

  it("names the file every producing menu item writes", () => {
    const prompt = (id: TeamId, code: string) =>
      (agentOf(id).agent?.menu.find((item) => item.code === code)?.prompt ?? "").replace(
        /\s+/g,
        " ",
      );
    expect(prompt("chloe", "DA")).toContain(
      "`.agentplugged/docs/security-reviews/<date>-<topic>.md`",
    );
    expect(prompt("chloe", "AC")).toContain(
      "`.agentplugged/docs/security-reviews/<date>-<topic>.md`",
    );
    expect(prompt("quentin", "CV")).toContain("`.agentplugged/docs/qa-reviews/coverage.md`");
    expect(prompt("julien", "VI")).toContain("`.agentplugged/docs/launch/visuals/`");
    expect(prompt("julien", "VI")).toContain("`publication` checkpoint");
    // Contents and campaign plans are written by the `write-content` skill.
    for (const code of ["CT", "CP"]) {
      expect(agentOf("julien").agent?.menu.find((item) => item.code === code)?.skill, code).toBe(
        "write-content",
      );
    }
    expect(agentOf("lou").agent?.menu.find((item) => item.code === "ID")?.skill).toBe("ideation");
    expect(prompt("tess", "CM")).toContain("`.agentplugged/docs/test-strategy.md`");
  });

  it("lets Omar roll back a down production at once, and report it right after", () => {
    const rules = (section(agentOf("omar").body, "Method rules") ?? "").replace(/\s+/g, " ");
    expect(rules).toContain("roll back to the last approved release without waiting");
    expect(rules).toContain("never covers a forward deployment");
  });

  it("keeps the developers in the story's branch, declaring cost and progress, never merging", () => {
    for (const id of CODE_ONLY) {
      // The developers' rules are the develop-story skill's and the constitution's.
      const develop = flat(
        readFileSync(join(methodDir, "skills", "develop-story", "SKILL.md"), "utf8"),
      );
      const constitution = flat(renderConstitution());
      const corpus = `${develop} ${constitution} ${flat(agentOf(id).text)} ${flat(agentOf(id).agentText ?? "")}`;
      for (const rule of [
        "its own working copy",
        "Only the engine merges",
        "`story.progress`",
        "`measure.cost`",
        "`story.status`",
        "`agent: <your id>`",
      ]) {
        expect(corpus, `${id}: ${rule}`).toContain(rule);
      }
    }
  });

  it("names no language, framework nor stack in a developer's definition", () => {
    // The product may use any stack (Ruby, C, C++, PHP, Perl…): a developer reads it in the
    // architecture and the knowledge base, never in its own definition.
    const STACK = new Set([
      ...["javascript", "typescript", "python", "java", "kotlin", "swift", "ruby", "rails"],
      ...["php", "laravel", "symfony", "perl", "golang", "rust", "scala", "elixir", "erlang"],
      ...["haskell", "csharp", "dotnet", "node", "nodejs", "deno", "bun", "react", "vue"],
      ...["angular", "svelte", "nextjs", "nuxt", "django", "flask", "fastapi", "express"],
      ...["nestjs", "spring", "flutter", "dart", "android", "ios", "swiftui", "tailwind"],
      ...["bootstrap", "jest", "vitest", "pytest", "junit", "mocha", "cypress", "playwright"],
      ...["postgres", "postgresql", "mysql", "sqlite", "mongodb", "redis", "sql", "graphql"],
      ...["docker", "kubernetes", "terraform", "webpack", "vite", "npm", "pnpm", "yarn"],
      ...["pip", "maven", "gradle", "cargo", "html", "css", "jquery", "wordpress", "unity"],
    ]);
    const texts = [
      ...CODE_ONLY.flatMap((id) => [agentOf(id).text, agentOf(id).agentText ?? ""]),
      readFileSync(
        join(methodDir, "skills", "develop-story", "references", "quick-lane.md"),
        "utf8",
      ),
    ];
    for (const text of texts) {
      const found = [...words(text)].filter((word) => STACK.has(word));
      expect(found).toEqual([]);
      for (const symbol of ["c++", "c#", ".net", "next.js", "node.js", "vue.js"]) {
        expect(text.toLowerCase()).not.toContain(symbol);
      }
    }
  });

  it("makes the quick lane a mode of the developer, back to the full lane when it must", () => {
    const body = readFileSync(
      join(methodDir, "skills", "develop-story", "references", "quick-lane.md"),
      "utf8",
    ).replace(/\s+/g, " ");
    for (const limit of [
      "one story",
      "no public interface",
      "no data migration",
      "no dependency",
      "fewer than 5 files, tests included",
      "always has a story",
      "`feat/<story>-<slug>`",
      "`story.start` with `fast_track`",
      "engine reads what it can in the repository; you declare what only you can know",
      "the goal can be read two ways",
      "a step could not be undone",
      "the change keeps growing",
      "`story.leave_fast_track`",
      "The way back to the full lane is final",
      "review before merging always happens",
      "by the creator when the product's profile has no quality agent",
      "Never skip the test, the full verification, the independent review nor the creator's validation before the merge",
      "Never enter the quick lane for a story already started",
    ]) {
      expect(body, limit).toContain(limit);
    }
  });

  it("makes Quentin and Chloé review through the engine, never through the pull request", () => {
    const rules = (id: TeamId) =>
      (section(agentOf(id).body, "Method rules") ?? "").replace(/\s+/g, " ");
    expect(rules("quentin")).toContain(
      "he submits his review with `review.submit`, never posts nor reads comments on the pull request himself",
    );
    expect(rules("quentin")).toContain("never opens `.agentplugged/docs/security-reviews/`");
    expect(rules("chloe")).toContain(
      "she submits her review with `review.submit`, never posts nor reads comments on the pull request herself",
    );
    expect(rules("chloe")).toContain("never opens `.agentplugged/docs/qa-reviews/`");
    for (const id of ["quentin", "chloe"] as const) {
      expect(
        (agentOf(id).agent?.menu ?? []).some((item) => item.skill === "review-story"),
        id,
      ).toBe(true);
    }
    expect(
      (agentOf("quentin").agent?.menu ?? []).some((item) => item.skill === "check-requirements"),
    ).toBe(true);
  });

  it("keeps Julien and Milo from publishing, sending or paying", () => {
    for (const id of ["julien", "milo"] as const) {
      const { body, agent } = agentOf(id);
      const rules = (section(body, "Method rules") ?? "").replace(/\s+/g, " ");
      expect(rules, id).toContain("never publishes, sends nor pays anything");
      expect(rules, id).toContain("`publication` checkpoint");
      const prompts = (agent?.menu ?? []).map((item) => item.prompt ?? "").join(" ");
      expect(prompts, id).toContain("`publication` checkpoint");
    }
  });

  it("describes the full story header once, in Izzy's deliverables, and her story prompt points to it", () => {
    const { body, agent } = agentOf("izzy");
    const deliverablesText = (section(body, "Deliverables") ?? "").replace(/\s+/g, " ");
    const prompt = (agent?.menu.find((item) => item.code === "ST")?.prompt ?? "").replace(
      /\s+/g,
      " ",
    );
    for (const field of [
      "`id`",
      "`kind: story`",
      "`owner`",
      "`links`",
      "`title`",
      "`epic`",
      "`reviewer`",
      "`requirements`",
      "`budget_usd`",
      "`branch`",
      "`depends_on`",
    ]) {
      expect(deliverablesText, field).toContain(field);
    }
    expect(prompt).toContain("described under Deliverables");
  });

  it("lists the team in the method's README", () => {
    const readme = readFileSync(join(methodDir, "README.md"), "utf8");
    for (const id of TEAM_IDS) {
      expect(readme).toContain(`| \`${id}\` | ${TEAM[id].name}, ${TEAM[id].title} |`);
    }
    expect(readme).toContain("| `noah` | Noah, Main Session Assistant |");
  });

  it("makes no skill tell the creator to pick the next agent alone", () => {
    for (const name of readdirSync(join(methodDir, "skills"))) {
      const path = join(methodDir, "skills", name, "SKILL.md");
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8").replace(/\s+/g, " ");
      expect(text, name).not.toContain("the creator chooses who works next");
    }
  });
});

describe("Noah, the main session's assistant", () => {
  const noah = () => {
    const definition = agents.get("noah");
    if (definition?.agent === undefined) throw new Error("noah is not shipped");
    return definition;
  };

  it("has the anatomy of the other agents, and no deliverable", () => {
    const { agent, body, frontmatter } = noah();
    expect(agent?.name).toBe("Noah");
    expect(agent?.title).toBe("Main Session Assistant");
    expect((frontmatter as AgentFrontmatter).metadata).toMatchObject({
      domain: "product",
      risk: "low",
      model_tier: "reasoning",
    });
    expect((frontmatter as AgentFrontmatter).metadata.specialty).toBeUndefined();
    for (const field of ["icon", "role", "identity", "communication_style"] as const) {
      expect(agent?.[field], field).toBeTruthy();
    }
    expect(agent?.principles.length).toBeGreaterThanOrEqual(4);
    expect(agent?.principles.length).toBeLessThanOrEqual(7);
    expect(agent?.menu.length).toBeGreaterThanOrEqual(4);
    expect(agent?.menu.length).toBeLessThanOrEqual(7);
    expect(agent?.voice).toBeDefined();
    // Five sections: his whole role, read at once (no reference before his first answer).
    for (const title of [
      "Role and voice",
      "The engine's contract",
      "Handing work over",
      "Decisions",
      "The session",
    ]) {
      expect(
        body.split("\n").filter((line) => line === `## ${title}`),
        title,
      ).toHaveLength(1);
    }
    expect(deliverables(body)).toEqual([]);
    expect(flat(section(body, "Role and voice") ?? "")).toContain("Noah owns no deliverable");
  });

  it("is the creator's right hand, calm and demanding, who never codes", () => {
    const { agent } = noah();
    const persona = flat(
      [agent?.role, agent?.identity, agent?.communication_style, ...(agent?.principles ?? [])].join(
        " ",
      ),
    );
    for (const trait of [
      "right hand",
      "sets the course and decides",
      "recommendation",
      "Calm, structured and demanding on quality",
      "as to his boss, without flattery",
      "Refuse what is vague, what is botched and what goes beyond the scope",
      "run independent tasks in parallel",
      "Never write code",
      "at most eight questions",
      "One decision at a time",
    ]) {
      expect(persona, trait).toContain(trait);
    }
  });

  it("hands work over and records it, presents decisions one at a time, leaves sprints to Izzy", () => {
    const body = flat(noahCorpus(methodDir));
    for (const rule of [
      "`state.get`",
      "`state.next`",
      "`agent.delegate`",
      "mode `conversation`",
      "mode `autonomous`",
      '"Sam · story 4-2"',
      "a story never goes to two developers",
      '"🔄 Alex is analysing the architecture…"',
      '"✅ Alex proposes two options"',
      "one at a time",
      "`chat.answer`",
      "never treats silence as a yes",
      "job description",
      "`guard.creator_action`",
      "Noah never breaks the plan down nor plans a sprint: he hands that to Izzy",
      "`ROLE_FORBIDDEN`",
      "Noah writes nothing: not in `docs/`, `epics/` or `stories/`",
      "He writes no code",
    ]) {
      expect(body, rule).toContain(rule);
    }
    const boundaries = flat(section(noah().body, "Handing work over") ?? "");
    for (const id of TEAM_IDS) expect(boundaries, id).toContain(TEAM[id].name);
  });

  it("names no AI tool, language nor stack in his definition", () => {
    const text = noahCorpus(methodDir);
    const agentText = "";
    const all = `${text}\n${agentText ?? ""}`;
    for (const tool of ["claude", "codex", "cursor", "gemini", "antigravity", ".claude", "/iris"]) {
      expect(all.toLowerCase(), tool).not.toContain(tool);
    }
    for (const word of ["typescript", "python", "react", "node"]) {
      expect(words(all).has(word), word).toBe(false);
    }
  });
});

/**
 * SHA-256 of the lowercased words that may never appear in the product: the name of the reference
 * system the agents were modelled on, the names of its agents, and personal names. Only their
 * hashes are stored, so the repository never holds the words themselves.
 */
const BANNED_WORD_HASHES = new Set([
  "4cb520700a736a67470725d981250d597924510cecb87fd19da7e98ec878c7f2",
  "6915771be1c5aa0c886870b6951b03d7eafc121fea0e80a5ea83beb7c449f4ec",
  "96d9632f363564cc3032521409cf22a852f2032eec099ed5967c0d000cec607a",
  "97897a111d485af1048bece173d2980a15870ca079281b79c7ca755356847602",
  "ea66f06bd8d37bbf7f74fcf064cd23af4aa104eadb0aa13684484b88a7e1c202",
  "81b637d8fcd2c6da6359e6963113a1170de795e4b725b84d1e0b4cfd9ec58ce9",
  "7b443e7a5d6f7b0b3b700b540cd46338be7808dfc815acf83a9e80111c4bdd97",
  "21925c6533087ac62c231badd02038fac5d0ee3276bea12a3130a90812443827",
  "f0d9991c5e47e0d26a350c1618bd3154cd0f9f2461d3df671a753c393fe7a6a7",
  "03c89ce8d8791b5dbd38378749b2fa9db008ca4dc09d3ab0f339815fe3d8edff",
  "b9f9ab6a93532d055272dadadef56288b514ff25bf639b12507e062a9c37b0af",
  "c512ca0c5c1e71be19f3356821e56732b5fb3ac894b0dbc5846d0b6920106fb3",
  "fc5a299cd6cd644f40bdcc8f7ae00e89a4ae4fbc44031c4bc27e54dd4bcb9773",
  "39e561055df141c2be5128a67add628ab3156716dedb08d780158a995dd55278",
  "99bde068af2d49ed7fc8b8fa79abe13a6059e0db320bb73459fd96624bb4b33f",
  "2742fb61a239b215bb23ca533d211faa359455dc7f8e9cc65e079c02f2c76393",
]);
/** Folders scanned, with every file directly at the root of the repository but `README.md`. */
const SCANNED_DIRS = ["apps", "packages", "method", "infra", "tooling", ".github"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".turbo", "results"]);

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...filesUnder(join(dir, entry.name)));
    } else if (entry.isFile()) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

/** Lowercased word tokens: letters and digits, also split where a lowercase meets an uppercase. */
function words(text: string): Set<string> {
  const tokens = text
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  return new Set(tokens.filter((token) => token !== ""));
}

const hashes = new Map<string, string>();
function isBanned(word: string): boolean {
  let hash = hashes.get(word);
  if (hash === undefined) {
    hash = sha256Hex(word);
    hashes.set(word, hash);
  }
  return BANNED_WORD_HASHES.has(hash);
}

describe("no trace of the reference system", () => {
  it("keeps its names and terms, and personal names, out of the product", () => {
    const rootFiles = readdirSync(repoRoot, { withFileTypes: true })
      // `.git` is a file in a Git worktree: it holds a local path, not product content.
      // The root `README.md` is the creator's private planning document, not part of the
      // product (the public repository is a separate one): it is not scanned.
      .filter((entry) => entry.isFile() && entry.name !== ".git" && entry.name !== "README.md")
      .map((entry) => join(repoRoot, entry.name));
    const offending = [
      ...rootFiles,
      ...SCANNED_DIRS.flatMap((dir) => filesUnder(join(repoRoot, dir))),
    ]
      .filter((file) => {
        const bytes = readFileSync(file);
        // Binary files (with a NUL byte) are skipped; every other file is read as UTF-8.
        if (bytes.includes(0)) return false;
        return [...words(bytes.toString("utf8"))].some(isBanned);
      })
      .map((file) => relative(repoRoot, file).replaceAll("\\", "/"));
    expect(offending).toEqual([]);
  });
});

describe("decisions to click in the texts of the method", () => {
  /** Every text that tells an agent how the creator is asked a decision. */
  const texts = () => {
    const skills = readdirSync(join(methodDir, "skills")).flatMap((name) => {
      const file = join(methodDir, "skills", name, "SKILL.md");
      return existsSync(file) ? [{ name: `skills/${name}`, text: readFileSync(file, "utf8") }] : [];
    });
    const agents = [
      // Noah's detail is in his references: his definition is all of it.
      { name: "agents/noah/(definition and references)", text: noahCorpus(methodDir) },
      ...["SKILL.md", "agent.yaml"].map((file) => ({
        name: `agents/izzy/${file}`,
        text: readFileSync(join(methodDir, "agents", "izzy", file), "utf8"),
      })),
    ];
    return [...skills, ...agents].map(({ name, text }) => ({
      name,
      text: text.replace(/\s+/g, " "),
    }));
  };

  it("never ties the engine's question to the form alone: the engine picks the channel", () => {
    for (const { name, text } of texts()) {
      // The old rule: ask the engine only when `validation.elicitation` is true.
      expect(text, name).not.toContain("`validation.elicitation` is true");
      expect(text, name).not.toContain("`validation.elicitation` in the answer");
    }
  });

  it("tells the 18 skills that ask a decision about the three channels and the answer that stays", () => {
    // The rule is written once in the reference; the skills that ask a decision point to it.
    const shared = sharedRules();
    expect(shared).toContain("`validation.channels.available`");
    expect(shared).toContain('`channel: "question_tool"`');
    expect(shared).toContain('`via: "question_tool"`');
    // Ask in the chat only when nothing was asked: the question tool's dictation says `answered: false` too.
    expect(shared).toContain('`answered: false` with `channel: "chat"`');
    const asking = texts().filter(
      ({ name, text }) => name.startsWith("skills/") && text.includes(SHARED_RULES_POINTER),
    );
    expect(asking.length).toBeGreaterThanOrEqual(18);
  });

  it("names no AI tool in Noah's definition: the engine's result names the tool to ask with", () => {
    const noahTexts = texts().filter(({ name }) => name.startsWith("agents/noah/"));
    expect(noahTexts).toHaveLength(1);
    for (const { name, text } of noahTexts) {
      expect(text, name).toContain("`validation.channels");
      expect(text, name).toContain('via: "question_tool"');
      expect(text, name).not.toContain("AskUserQuestion");
    }
  });
  it("ships no procedure for a document review meeting (the method is written for one agent at a time)", () => {
    expect(existsSync(join(methodDir, "skills", "round-table", "references", "review.md"))).toBe(
      false,
    );
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
        } else if (/\.(md|ya?ml)$/.test(entry.name)) files.push(full);
      }
    };
    walk(methodDir);
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const text = flat(readFileSync(file, "utf8"));
      const name = relative(methodDir, file);
      expect(text, name).not.toMatch(/review meeting/i);
      expect(text, name).not.toContain("references/review.md");
      expect(text, name).not.toContain("format: review");
    }
    // Basile stays in the method as an agent, and is not tied to a meeting in the chat.
    expect(existsSync(join(methodDir, "agents", "basile", "SKILL.md"))).toBe(true);
  });
});
