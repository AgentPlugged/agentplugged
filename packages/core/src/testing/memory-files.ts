import shippedDoctor from "../../../../method/doctor.yaml?raw";
import shippedModels from "../../../../method/models.yaml?raw";
import { REFERENCE_FILE_ORDER } from "../init/constitution.js";
import { REFERENCE_DIR } from "../init/layout.js";
import type { WorkspaceFiles } from "../workspace-files.js";

/** In-memory workspace that records every write and removal (tests only, never built). */
export class MemoryFiles implements WorkspaceFiles {
  readonly files = new Map<string, string>();
  readonly binaries = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  readonly writes: string[] = [];
  readonly removals: string[] = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) this.seed(path, content);
  }

  /**
   * The whole reference (one file per section under `.agentplugged/reference/`), the
   * files joined in the order of the sections; empty when there is none.
   */
  reference(): string {
    const names = [...this.files.keys()]
      .filter((path) => path.startsWith(`${REFERENCE_DIR}/`))
      .map((path) => path.slice(REFERENCE_DIR.length + 1, -".md".length));
    const rank = (name: string) => {
      const index = REFERENCE_FILE_ORDER.indexOf(name);
      return index === -1 ? REFERENCE_FILE_ORDER.length : index;
    };
    names.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
    return names.map((name) => this.files.get(`${REFERENCE_DIR}/${name}.md`)).join("\n");
  }

  seed(path: string, content: string): void {
    this.binaries.delete(path);
    this.files.set(path, content);
    this.addParents(path);
  }

  seedBytes(path: string, content: Uint8Array): void {
    this.files.delete(path);
    this.binaries.set(path, content);
    this.addParents(path);
  }

  private addParents(path: string): void {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
  }

  async exists(path: string) {
    return this.files.has(path) || this.binaries.has(path) || this.dirs.has(path);
  }
  async readText(path: string) {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT (or binary file): ${path}`);
    return content;
  }
  async readBytes(path: string) {
    const bytes = this.binaries.get(path);
    if (bytes === undefined) throw new Error(`ENOENT (or text file): ${path}`);
    return bytes;
  }
  async writeText(path: string, content: string) {
    this.writes.push(path);
    this.seed(path, content);
  }
  async writeBytes(path: string, content: Uint8Array) {
    this.writes.push(path);
    this.seedBytes(path, content);
  }
  async mkdir(path: string) {
    this.writes.push(`${path}/`);
    this.dirs.add(path);
    this.addParents(path);
  }
  async listFiles(dir: string) {
    const prefix = `${dir}/`;
    return [...this.files.keys(), ...this.binaries.keys()]
      .filter((path) => path.startsWith(prefix))
      .sort();
  }
  async listEntries(dir: string) {
    const prefix = dir === "" ? "" : `${dir}/`;
    const names = new Set<string>();
    for (const path of [...this.files.keys(), ...this.binaries.keys(), ...this.dirs]) {
      if (!path.startsWith(prefix) || path === dir) continue;
      const name = path.slice(prefix.length).split("/")[0];
      if (name !== undefined && name !== "") names.add(name);
    }
    return [...names].sort();
  }
  async createText(path: string, content: string) {
    if (await this.exists(path)) return false;
    await this.writeText(path, content);
    return true;
  }
  async remove(path: string) {
    if (this.files.delete(path) || this.binaries.delete(path)) {
      this.removals.push(path);
      return;
    }
    if (!this.dirs.has(path)) return;
    const prefix = `${path}/`;
    const busy =
      [...this.files.keys(), ...this.binaries.keys()].some((file) => file.startsWith(prefix)) ||
      [...this.dirs].some((dir) => dir.startsWith(prefix));
    if (busy) throw new Error(`ENOTEMPTY: ${path}`);
    this.dirs.delete(path);
    this.removals.push(`${path}/`);
  }

  removeDir(path: string): void {
    this.dirs.delete(path);
    for (const dir of [...this.dirs]) if (dir.startsWith(`${path}/`)) this.dirs.delete(dir);
    for (const file of [...this.files.keys()])
      if (file.startsWith(`${path}/`)) this.files.delete(file);
  }

  snapshot(): Map<string, string> {
    return new Map(this.files);
  }
}

/** `SKILL.md` of the sample agent shipped by the method, as tests see it. */
export const SHIPPED_IRIS = `---
name: iris
description: Product analyst who frames a new product.
metadata:
  domain: product
  phase: framing
  risk: low
  model_tier: reasoning
---
# Iris

Frame the product.
`;

/** `agent.yaml` of the sample agent, as tests see it. */
export const SHIPPED_IRIS_AGENT = `name: Iris
title: Product Analyst
icon: "🔎"
role: Frames products.
identity: A curious analyst.
communication_style: Calm and precise.
principles:
  - Problem first.
persistent_facts:
  - Notes live in docs.
  - "file:docs/rules.md"
activation_steps_prepend:
  - Read the brief.
activation_steps_append:
  - List open questions.
menu:
  - code: FP
    description: Frame the problem
    prompt: Ask who has the problem | and why.
  - code: BR
    description: Brainstorm
    prompt: Brainstorm ideas.
`;

/** The model table of the real method package (`method/models.yaml`). */
export const SHIPPED_MODELS: string = shippedModels;

/** The checks of `doctor` of the real method package (`method/doctor.yaml`). */
export const SHIPPED_DOCTOR: string = shippedDoctor;

/**
 * A minimal shipped agent for tests (`agents/<id>/SKILL.md` and `agent.yaml`): its domain, and a
 * developer's specialty when given.
 */
export function fixtureAgent(
  id: string,
  options: {
    readonly name?: string;
    readonly domain?: string;
    readonly specialty?: string;
    /** Skills its menu calls. */
    readonly skills?: readonly string[];
  } = {},
): Record<string, string> {
  const name = options.name ?? id[0]?.toUpperCase() + id.slice(1);
  const specialty = options.specialty === undefined ? "" : `  specialty: ${options.specialty}\n`;
  const menu =
    options.skills === undefined || options.skills.length === 0
      ? ""
      : `menu:\n${options.skills
          .map(
            (skill, i) => `  - code: S${i}\n    description: Run ${skill}\n    skill: ${skill}\n`,
          )
          .join("")}`;
  return {
    [`agents/${id}/SKILL.md`]: `---
name: ${id}
description: ${name}, an agent of the tests.
metadata:
  domain: ${options.domain ?? "product"}
  phase: framing
  risk: low
  model_tier: reasoning
${specialty}---
# ${name}

Work.
`,
    [`agents/${id}/agent.yaml`]: `name: ${name}\ntitle: Agent of the tests\n${menu}`,
  };
}

/** A minimal shipped skill for tests (`skills/<id>/SKILL.md`). */
export function fixtureSkill(id: string): Record<string, string> {
  return {
    [`skills/${id}/SKILL.md`]: `---\nname: ${id}\ndescription: A skill of the tests.\n---\n# ${id}\n`,
  };
}

/** The shipped method: Iris and the model table, like the real package. */
export function shippedMethod(extra: Record<string, string> = {}): MemoryFiles {
  return new MemoryFiles({
    "agents/iris/SKILL.md": SHIPPED_IRIS,
    "agents/iris/agent.yaml": SHIPPED_IRIS_AGENT,
    "models.yaml": SHIPPED_MODELS,
    "doctor.yaml": SHIPPED_DOCTOR,
    ...extra,
  });
}
