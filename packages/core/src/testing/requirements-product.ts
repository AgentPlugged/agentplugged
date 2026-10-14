import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import type { PhaseId } from "@agentplugged/protocol";
import {
  type AgentStateView,
  type CandidateLine,
  type CommandContext,
  createCommandRegistry,
  createUlidFactory,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type ProofRunner,
  type RecordedEvent,
  type RequirementsSynced,
  resolveProfile,
  syncCommand,
  type TestReferenceRead,
  type TestReferenceSource,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, SHIPPED_IRIS, SHIPPED_IRIS_AGENT, shippedMethod } from "./memory-files.js";

/**
 * A product with its framing, planning and design closed, its PRD, architecture and two stories,
 * and the agents that audit and release: the starting point of the
 * end-to-end tests of the non-functional requirements and of their proofs.
 */

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(9));

export function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

export const PRD = [
  "---",
  "id: prd",
  "kind: prd",
  "owner: creator",
  "---",
  "# PRD",
  "",
  "- EF-1: The visitor signs in.",
  "- ENF-1: A page answers in at most 300 ms, measured by `pnpm bench`.",
  "- ENF-2: The sign-in has tests for its failure cases, measured by the test suite.",
  "- ENF-3: No known vulnerability in the dependencies, measured by `npm audit`.",
  "- ENF-4: The screens are usable with the keyboard alone (WCAG AA), verified by review.",
  "",
].join("\n");

export const ARCHITECTURE = [
  "---",
  "id: architecture",
  "kind: architecture",
  "owner: creator",
  "---",
  "# Architecture",
  "",
  "### AD-1 — One writer per piece of data",
  "",
  "- **Budget:** a replay takes under 2 s for 10 000 events.",
  "",
].join("\n");

export const story = (id: string, requirements: string[]) =>
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

class FakeTests implements TestReferenceSource {
  lines: CandidateLine[] = [];
  async read(): Promise<TestReferenceRead> {
    return { found: true, lines: this.lines, files: [], truncated: false };
  }
}

export const OPTIONS = [
  {
    id: "fix",
    label: "Fix it",
    consequence: "A story is proposed; the release waits for the proof.",
  },
  { id: "accept", label: "Accept the risk", consequence: "The release goes, with your reason." },
  { id: "defer", label: "Defer it", consequence: "It goes to a later version." },
];

export async function product(
  options: {
    readonly proofRunner?: ProofRunner;
    /** More of the context every command gets (the product folder, the main branch). */
    readonly context?: Partial<CommandContext>;
    /** More files of the shipped method (Noah, whose turn the loop is). */
    readonly method?: Readonly<Record<string, string>>;
  } = {},
) {
  const files = new MemoryFiles();
  let clock = Date.UTC(2026, 9, 9, 9, 0, 0);
  const now = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now, newId: createUlidFactory({ now }) });
  const tests = new FakeTests();
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...shippedAgent("sam", "Sam", "code", "build"),
      ...shippedAgent("quentin", "Quentin", "quality", "build"),
      ...shippedAgent("omar", "Omar", "delivery", "delivery"),
    }),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
    testReferences: tests,
    ...(options.proofRunner === undefined ? {} : { proofRunner: options.proofRunner }),
    ...options.context,
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", human: undefined };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>) => registry.run(name, agent, input);
  const run = async (name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok)
      throw new Error(
        `${name} failed: ${result.error.code} ${JSON.stringify(result.error.details)}`,
      );
    return result.value;
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
  for (const phase of ["framing", "planning", "design"] as const) {
    const opened = (await run("open_checkpoint", {
      agent: closers[phase],
      type: "phase_end",
      phase,
      risk: "low",
      title: `End of ${phase}`,
      summary: "Ready.",
    })) as RecordedEvent;
    await approve(opened.checkpoint);
  }
  // Noah joins once the phases are closed (while he is there, the main session is he
  // and opens no point), installed in the product's folder as `init` does.
  if (options.method !== undefined) {
    for (const [path, text] of Object.entries(options.method)) {
      files.seed(`.agentplugged/${path}`, text);
    }
    const again = await syncCommand.run(human, {});
    if (!again.ok) throw new Error(`sync failed: ${again.error.code}`);
  }
  files.seed(".agentplugged/docs/prd.md", PRD);
  files.seed(".agentplugged/docs/architecture.md", ARCHITECTURE);
  files.seed(".agentplugged/stories/1-1-page.md", story("1-1", ["ENF-1"]));
  files.seed(".agentplugged/stories/1-2-signin.md", story("1-2", ["ENF-2"]));
  const state = async () => (await run("get_state", { full: true })) as AgentStateView;
  const sync = async () =>
    (await run("sync_requirements", { agent: "quentin" })) as unknown as RequirementsSynced;
  const releaseOf = async () =>
    (await run("open_checkpoint", {
      agent: "omar",
      type: "release",
      risk: "medium",
      title: "Release 1.0",
      summary: "Ship 1.0.",
    })) as RecordedEvent;
  /** A decision point on a gap, answered by the creator with `option`. */
  const decideGap = async (
    requirement: string,
    option: string,
    title = `Gap on ${requirement}`,
  ) => {
    const opened = (await run("open_checkpoint", {
      agent: "omar",
      type: "decision",
      risk: "medium",
      title,
      summary: "No valid proof.",
      options: OPTIONS,
      recommendation: "fix",
    })) as RecordedEvent;
    const answered = await resolve(opened.checkpoint, { decision: "option_chosen", option });
    if (!answered.ok) throw new Error(`review failed: ${answered.error.code}`);
    return opened.checkpoint as string;
  };
  /** A story of the product delivered (its point approved): the code a requirement covers changed. */
  const deliver = async (id: string) => {
    const opened = (await run("open_checkpoint", {
      agent: "sam",
      type: "story",
      risk: "low",
      title: `Story ${id}`,
      summary: "Done.",
      story: id,
    })) as RecordedEvent;
    await approve(opened.checkpoint);
  };
  return {
    journal,
    agent,
    human,
    registry,
    tests,
    files,
    call,
    run,
    resolve,
    approve,
    state,
    sync,
    releaseOf,
    decideGap,
    deliver,
  };
}
