import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { DOMAIN_IDS, ErrorCode, PHASE_IDS, type PhaseId } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  AgentPluggedError,
  type AgentStateView,
  activePhases,
  byStoryId,
  type CheckpointState,
  type CommandContext,
  createCommandRegistry,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type NextConfig,
  type NextDocs,
  type NextResult,
  type NextState,
  nextStep,
  PROFILE_PRESETS,
  phaseProgress,
  type RecordedEvent,
  resolveProfile,
  type StateStore,
  SYNC_MANIFEST_PATH,
  type SyncFreshness,
  syncCommand,
  syncInputsFingerprint,
  syncNeed,
  type ToolProbe,
} from "../index.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const TOOLS = ["claude-code", "codex", "antigravity", "cursor"] as const;

const SYNCED: SyncFreshness = { manifest: true, missing: [], recorded: "a", current: "a" };

const AGENTS = {
  iris: "Iris",
  maya: "Maya",
  stella: "Stella",
  alex: "Alex",
  izzy: "Izzy",
  quentin: "Quentin",
  sam: "Sam",
  "sam-2": "Sam 2",
  omar: "Omar",
  julien: "Julien",
  milo: "Milo",
};

const CONFIG: NextConfig = {
  domains: DOMAIN_IDS,
  phases: PHASE_IDS,
  tools: TOOLS,
  preferred: {},
  agents: AGENTS,
};

/** Only the build phase is active: the stories alone decide. */
const BUILD: NextConfig = { ...CONFIG, phases: ["build"] };

const NO_DOCS: NextDocs = { kinds: [], stories: [] };
const ALL_DOCS: NextDocs = { kinds: ["brief", "prd", "ux", "architecture", "epic"], stories: [] };

function state(projection: Record<string, unknown> = {}, sync = SYNCED): NextState {
  return { projection, now: NOW, sync };
}

/** A checkpoint as the projection keeps it: only what `next` reads. */
function checkpoint(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "story",
    risk: "low",
    title: `Title of ${id}`,
    status: "open",
    story: null,
    blocks: [],
    opened_by: "iris",
    opened_event: `01JZ00000000000000000${id.slice(-5)}`,
    resolution: null,
    blocks_lifted: false,
    phase: null,
    ...extra,
  };
}

/** The end of `phase`, approved at the `hour` of the day before (an ordering of the answers). */
function phaseEnd(phase: PhaseId, hour: number, extra: Record<string, unknown> = {}) {
  const at = new Date(Date.UTC(2026, 9, 3, hour)).toISOString();
  return checkpoint(`G-P${String(hour).padStart(4, "0")}`, {
    type: "phase_end",
    phase,
    status: "resolved",
    opened_event: `01JZ0000000000000000P${String(hour).padStart(5, "0")}`,
    resolution: { decision: "approved", waiver_until: null, at, event: `E${hour}` },
    ...extra,
  });
}

/** The checkpoints of the phases closed in this order, one hour apart. */
function closed(...phases: PhaseId[]): Record<string, unknown> {
  const checkpoints: Record<string, unknown> = {};
  phases.forEach((phase, index) => {
    const end = phaseEnd(phase, index + 1);
    checkpoints[end.id] = end;
  });
  return checkpoints;
}

function story(status: string, agent: string | null, at = "2026-10-04T10:00:00.000Z") {
  return { status, status_by: agent === null ? null : { agent, at } };
}

const BLOCKS = [{ action: "story.review", story: "2-6" }];

describe("phases", () => {
  it("keeps the phases the profile lists that serve an active domain", () => {
    expect(activePhases(undefined)).toEqual(PHASE_IDS);
    expect(activePhases(PROFILE_PRESETS.maintenance)).toEqual(["build", "delivery"]);
    expect(activePhases(PROFILE_PRESETS["launch-only"])).toEqual(["framing", "launch"]);
    expect(activePhases(PROFILE_PRESETS.prototype)).toEqual(["framing", "build"]);
  });

  it("moves phase by phase on the approved ends, in the order of the answers", () => {
    const all = (phases: Record<string, unknown>) =>
      phaseProgress(Object.values(phases) as CheckpointState[], PHASE_IDS, NOW);
    expect(all({})).toMatchObject({ current: "framing", since: null, open: null });
    const two = all(closed("framing", "planning"));
    expect(two).toMatchObject({ current: "design", since: "2026-10-03T02:00:00.000Z" });
    expect(two.phases).toEqual([
      { id: "framing", status: "done" },
      { id: "planning", status: "done" },
      { id: "design", status: "in_progress" },
      { id: "build", status: "upcoming" },
      { id: "delivery", status: "upcoming" },
      { id: "launch", status: "upcoming" },
    ]);
    // An end approved out of order never counts, even once its phase comes.
    expect(all(closed("planning", "framing")).current).toBe("planning");
    // After the last phase, the build again.
    const loop = all(closed(...PHASE_IDS));
    expect(loop.current).toBe("build");
    expect(loop.phases.map((phase) => phase.status)).toEqual([
      "done",
      "done",
      "done",
      "in_progress",
      "upcoming",
      "upcoming",
    ]);
  });

  it("loops on the launch without a build, and stops without a repeating phase", () => {
    const launchOnly = ["framing", "launch"] as const;
    const ends = Object.values(closed("framing", "launch")) as CheckpointState[];
    expect(phaseProgress(ends, launchOnly, NOW).current).toBe("launch");
    const framingOnly = Object.values(closed("framing")) as CheckpointState[];
    expect(phaseProgress(framingOnly, ["framing"], NOW)).toMatchObject({ current: null });
    expect(phaseProgress([], [], NOW).current).toBeNull();
  });

  it("marks a skipped phase, and the current phase in review while its end is open", () => {
    const open = phaseEnd("build", 1, { status: "open", resolution: null });
    const progress = phaseProgress(
      [open as unknown as CheckpointState],
      ["build", "delivery"],
      NOW,
    );
    expect(progress.open?.id).toBe(open.id);
    expect(progress.phases.map((phase) => phase.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "in_review",
      "upcoming",
      "skipped",
    ]);
  });
  it("has nothing open nor refused without a current phase, and reports the ends aside", () => {
    const open = phaseEnd("framing", 1, { status: "open", resolution: null });
    const refused = phaseEnd("framing", 2, {
      resolution: { decision: "rejected", waiver_until: null, at: "2026-10-03T02:00:00.000Z" },
    });
    const ends = [open, refused] as unknown as CheckpointState[];
    expect(phaseProgress(ends, [], NOW)).toMatchObject({
      current: null,
      open: null,
      refused: null,
      stray: [{ checkpoint: open.id, phase: "framing", reason: "open_not_current" }],
    });
    // Every phase closed, none repeating: nothing open nor refused either.
    const framing = Object.values(closed("framing")) as CheckpointState[];
    expect(phaseProgress([...framing, ...ends], ["framing"], NOW)).toMatchObject({
      current: null,
      open: null,
      refused: null,
    });
  });

  it("never closes a phase on a waiver, and reopens an end whose waiver is past", () => {
    const waived = (until: number) =>
      phaseEnd("framing", 1, {
        status: "waived",
        resolution: {
          decision: "waived",
          waiver_until: new Date(until).toISOString(),
          at: "2026-10-03T01:00:00.000Z",
        },
      }) as unknown as CheckpointState;
    expect(phaseProgress([waived(NOW + DAY)], PHASE_IDS, NOW)).toMatchObject({
      current: "framing",
      open: null,
      refused: null,
    });
    const past = phaseProgress([waived(NOW - DAY)], PHASE_IDS, NOW);
    expect(past.current).toBe("framing");
    expect(past.open?.id).toBe("G-P0001");
  });

  it("resumes at an earlier phase the profile turns on again", () => {
    const ends = Object.values(closed("planning")) as CheckpointState[];
    expect(phaseProgress(ends, ["planning", "design"], NOW).current).toBe("design");
    const again = phaseProgress(ends, ["framing", "planning", "design"], NOW);
    expect(again.current).toBe("framing");
    expect(again.stray).toEqual([
      { checkpoint: "G-P0001", phase: "planning", reason: "approved_out_of_turn" },
    ]);
  });
});

describe("nextStep", () => {
  it("frames a new product with Iris, in the first targeted tool", () => {
    const step = nextStep(state(), NO_DOCS, CONFIG);
    expect(step).toMatchObject({
      step: "framing",
      you: false,
      agent: "iris",
      agent_name: "Iris",
      tool: "claude-code",
      waiting: [],
      command: null,
      story: null,
      checkpoint: null,
      sync: null,
      missing_tools: [],
      pending_keys: [],
      phase: "framing",
    });
    expect(step.phases[0]).toEqual({ id: "framing", status: "in_progress" });
  });

  it("calls the agent in its preferred tool only when that tool is targeted", () => {
    const preferred = { ...CONFIG, preferred: { iris: "codex" as const } };
    expect(nextStep(state(), NO_DOCS, preferred).tool).toBe("codex");
    const untargeted = { ...preferred, tools: ["cursor" as const] };
    expect(nextStep(state(), NO_DOCS, untargeted).tool).toBe("cursor");
  });

  it("asks the phase's agent to open its end once its deliverables are ready", () => {
    const docs = { kinds: ["brief"] as NextDocs["kinds"], stories: [] };
    expect(nextStep(state(), docs, CONFIG)).toMatchObject({
      step: "phase_end",
      phase: "framing",
      agent: "iris",
      command: null,
    });
    // Without Iris nor Lou, the creator opens it (through the main session).
    const { iris: _iris, ...withoutIris } = AGENTS;
    expect(nextStep(state(), docs, { ...CONFIG, agents: withoutIris })).toMatchObject({
      step: "phase_end",
      you: true,
      agent: null,
    });
  });

  it("waits for the creator on an open end of phase, then moves on once approved", () => {
    const docs = { kinds: ["brief"] as NextDocs["kinds"], stories: [] };
    const open = phaseEnd("framing", 1, { status: "open", resolution: null });
    const other = checkpoint("G-AAAAA");
    const step = nextStep(
      state({ checkpoints: { [other.id]: other, [open.id]: open } }),
      docs,
      CONFIG,
    );
    expect(step).toMatchObject({
      step: "phase_review",
      you: true,
      checkpoint: open.id,
      command: `npx agentplugged review ${open.id}`,
      phase: "framing",
    });
    expect(step.waiting.map((item) => item.id)).toEqual([open.id, "G-AAAAA"]);
    expect(step.phases[0]).toEqual({ id: "framing", status: "in_review" });
    expect(nextStep(state({ checkpoints: closed("framing") }), docs, CONFIG)).toMatchObject({
      step: "planning",
      phase: "planning",
      agent: "maya",
    });
  });

  it("sends a refused end of phase back to its agent until another one is opened", () => {
    const docs = { kinds: ["brief"] as NextDocs["kinds"], stories: [] };
    const refused = phaseEnd("framing", 1, {
      resolution: { decision: "changes_requested", waiver_until: null, at: "2026-10-03T01:00:00Z" },
    });
    expect(nextStep(state({ checkpoints: { [refused.id]: refused } }), docs, CONFIG)).toMatchObject(
      {
        step: "changes_requested",
        agent: "iris",
        checkpoint: refused.id,
        command: "npx agentplugged history",
        phase: "framing",
      },
    );
    const again = phaseEnd("framing", 2, { status: "open", resolution: null });
    const both = { checkpoints: { [refused.id]: refused, [again.id]: again } };
    expect(nextStep(state(both), docs, CONFIG)).toMatchObject({
      step: "phase_review",
      checkpoint: again.id,
    });
  });

  it("walks the documents of each phase: Maya, Stella, Alex, then Izzy", () => {
    const docs = (kinds: NextDocs["kinds"]) => ({ kinds, stories: [] });
    const after = (...phases: PhaseId[]) => state({ checkpoints: closed(...phases) });
    expect(nextStep(after("framing"), docs(["brief"]), CONFIG)).toMatchObject({
      step: "planning",
      agent: "maya",
    });
    expect(nextStep(after("framing"), docs(["brief", "prd"]), CONFIG)).toMatchObject({
      step: "ux_spec",
      agent: "stella",
      agent_name: "Stella",
    });
    expect(nextStep(after("framing"), docs(["brief", "prd", "ux"]), CONFIG)).toMatchObject({
      step: "phase_end",
      agent: "maya",
    });
    expect(
      nextStep(after("framing", "planning"), docs(["brief", "prd", "ux"]), CONFIG),
    ).toMatchObject({ step: "design", phase: "design", agent: "alex" });
    expect(
      nextStep(after("framing", "planning", "design"), docs(["architecture"]), CONFIG),
    ).toMatchObject({ step: "breakdown", phase: "build", agent: "izzy" });
  });

  it("skips Stella when the ux domain is inactive, and an agent that is not active", () => {
    const domains = DOMAIN_IDS.filter((domain) => domain !== "ux");
    const docs = { kinds: ["brief", "prd"] as NextDocs["kinds"], stories: [] };
    const planning = state({ checkpoints: closed("framing") });
    expect(nextStep(planning, docs, { ...CONFIG, domains })).toMatchObject({
      step: "phase_end",
      agent: "maya",
    });
    const { stella: _lea, ...withoutLea } = AGENTS;
    expect(nextStep(planning, docs, { ...CONFIG, agents: withoutLea })).toMatchObject({
      step: "phase_end",
      agent: "maya",
    });
  });

  it("skips the disabled phases in the maintenance profile", () => {
    const { domains, phases } = PROFILE_PRESETS.maintenance;
    const config = { ...CONFIG, domains, phases };
    const none = { kinds: [], stories: ["2-3"] };
    const step = nextStep(state(), none, config);
    // No planner in this profile: a developer takes the story.
    expect(step).toMatchObject({ step: "build", phase: "build", agent: "sam", story: "2-3" });
    expect(step.phases.map((phase) => phase.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "in_progress",
      "upcoming",
      "skipped",
    ]);
    const reviewing = state({ stories: { "2-3": story("in_review", "sam") } });
    expect(nextStep(reviewing, none, config)).toMatchObject({
      step: "review",
      agent: "quentin",
      story: "2-3",
    });
    expect(nextStep(state(), NO_DOCS, config)).toMatchObject({ step: "none", phase: "build" });
  });

  it("goes from the build to the delivery, then the launch, then the build again", () => {
    const built = closed("framing", "planning", "design", "build");
    expect(nextStep(state({ checkpoints: built }), ALL_DOCS, CONFIG)).toMatchObject({
      step: "delivery",
      phase: "delivery",
      agent: "omar",
    });
    const releaseAt = (at: string) =>
      checkpoint("G-RRRRR", {
        type: "release",
        status: "resolved",
        resolution: { decision: "approved", waiver_until: null, at },
      });
    const release = releaseAt("2026-10-03T05:00:00.000Z");
    // A release approved before the delivery began does not count.
    const early = releaseAt("2026-10-03T01:00:00.000Z");
    expect(
      nextStep(state({ checkpoints: { ...built, [release.id]: early } }), ALL_DOCS, CONFIG).step,
    ).toBe("delivery");
    expect(
      nextStep(state({ checkpoints: { ...built, [release.id]: release } }), ALL_DOCS, CONFIG),
    ).toMatchObject({ step: "phase_end", agent: "omar" });
    const delivered = closed("framing", "planning", "design", "build", "delivery");
    expect(nextStep(state({ checkpoints: delivered }), ALL_DOCS, CONFIG)).toMatchObject({
      step: "launch",
      phase: "launch",
      agent: "julien",
    });
    const noMarketing = DOMAIN_IDS.filter((domain) => domain !== "marketing");
    expect(
      nextStep(state({ checkpoints: delivered }), ALL_DOCS, { ...CONFIG, domains: noMarketing }),
    ).toMatchObject({ step: "launch", agent: "milo" });
    expect(nextStep(state({ checkpoints: closed(...PHASE_IDS) }), ALL_DOCS, CONFIG)).toMatchObject({
      step: "breakdown",
      phase: "build",
      agent: "izzy",
    });
  });

  it("calls the active agent that declared a story in progress, first by story order", () => {
    const projection = {
      stories: {
        "2-10": story("in_progress", "ethan"),
        "2-9": story("in_progress", "sam-2"),
        "2-1": story("in_review", "sam"),
      },
    };
    const step = nextStep(state(projection), ALL_DOCS, {
      ...BUILD,
      preferred: { "sam-2": "cursor" },
    });
    expect(step).toMatchObject({
      step: "build",
      you: false,
      agent: "sam-2",
      agent_name: "Sam 2",
      tool: "cursor",
      story: "2-9",
    });
  });

  it("still reports a story in progress whose agent is unknown, inactive or not given", () => {
    for (const agent of ["constructor", "ethan", null]) {
      const projection = { stories: { "2-1": story("in_progress", agent) } };
      expect(nextStep(state(projection), ALL_DOCS, BUILD)).toMatchObject({
        step: "build",
        you: true,
        agent: null,
        tool: null,
        story: "2-1",
      });
    }
  });

  it("sends a story in review to Quentin, or to the creator with a command", () => {
    const projection = { stories: { "2-3": story("in_review", "sam") } };
    expect(nextStep(state(projection), ALL_DOCS, BUILD)).toMatchObject({
      step: "review",
      agent: "quentin",
      story: "2-3",
    });
    const domains = DOMAIN_IDS.filter((domain) => domain !== "quality");
    expect(nextStep(state(projection), ALL_DOCS, { ...BUILD, domains })).toMatchObject({
      step: "review",
      you: true,
      agent: null,
      story: "2-3",
      command: "npx agentplugged history --story 2-3",
    });
  });

  it("closes the build once a story is done in it, none open", () => {
    const approved = (at: string) =>
      checkpoint("G-DONE1", {
        status: "resolved",
        story: "2-3",
        blocks: BLOCKS,
        blocks_lifted: true,
        resolution: { decision: "approved", waiver_until: null, at },
      });
    const done = {
      stories: { "2-3": story("in_review", "sam") },
      checkpoints: { "G-DONE1": approved("2026-10-04T11:00:00.000Z") },
    };
    expect(nextStep(state(done), ALL_DOCS, BUILD)).toMatchObject({
      step: "phase_end",
      phase: "build",
      agent: "izzy",
    });
    // Back in progress after the approval: not done.
    const reopened = {
      stories: { "2-3": story("in_progress", "sam", "2026-10-04T11:30:00.000Z") },
      checkpoints: { "G-DONE1": approved("2026-10-04T11:00:00.000Z") },
    };
    expect(nextStep(state(reopened), ALL_DOCS, BUILD)).toMatchObject({
      step: "build",
      agent: "sam",
    });
    // Done before the build began (an earlier loop): Izzy writes the next stories.
    const loop = {
      stories: { "2-3": story("in_review", "sam", "2026-10-03T00:00:00.000Z") },
      checkpoints: { ...closed(...PHASE_IDS), "G-DONE1": approved("2026-10-03T00:30:00.000Z") },
    };
    expect(nextStep(state(loop), ALL_DOCS, CONFIG)).toMatchObject({
      step: "breakdown",
      agent: "izzy",
    });
  });

  it("shows a blocked story with who declared it, or the creator", () => {
    const projection = { stories: { "2-1": story("blocked", "sam") } };
    expect(nextStep(state(projection), ALL_DOCS, BUILD)).toMatchObject({
      step: "story_blocked",
      agent: "sam",
      story: "2-1",
    });
    const unknown = { stories: { "2-1": story("blocked", "ghost") } };
    expect(nextStep(state(unknown), ALL_DOCS, BUILD)).toMatchObject({
      step: "story_blocked",
      you: true,
      story: "2-1",
    });
  });

  it("asks Izzy for a sprint plan when stories have no status, else a developer", () => {
    const docs = { ...ALL_DOCS, stories: ["2-1", "2-2"] };
    const projection = { stories: { "2-1": story("in_review", "sam") } };
    const done = {
      ...projection,
      checkpoints: {
        "G-DONE1": checkpoint("G-DONE1", {
          status: "resolved",
          story: "2-1",
          blocks_lifted: true,
          resolution: { decision: "approved", waiver_until: null, at: "2026-10-04T11:00:00Z" },
        }),
      },
    };
    expect(nextStep(state(done), docs, BUILD)).toMatchObject({
      step: "sprint_planning",
      agent: "izzy",
      story: null,
    });
    const { izzy: _sam, ...withoutSam } = AGENTS;
    expect(nextStep(state(done), docs, { ...BUILD, agents: withoutSam })).toMatchObject({
      step: "build",
      agent: "sam",
      story: "2-2",
    });
  });

  it("looks at the stories alone without any active phase", () => {
    const config = { ...CONFIG, domains: ["docs" as const] };
    expect(nextStep(state(), NO_DOCS, config)).toMatchObject({ step: "none", phase: null });
    const projection = { stories: { "2-1": story("blocked", "ghost") } };
    expect(nextStep(state(projection), NO_DOCS, config)).toMatchObject({
      step: "story_blocked",
      phase: null,
    });
  });

  it("keeps the build work before a refused end of the build, then sends the refusal back", () => {
    const refused = phaseEnd("build", 1, {
      opened_by: "izzy",
      resolution: { decision: "changes_requested", waiver_until: null, at: "2026-10-03T01:00:00Z" },
    });
    const done = checkpoint("G-DONE1", {
      status: "resolved",
      story: "2-1",
      blocks_lifted: true,
      resolution: { decision: "approved", waiver_until: null, at: "2026-10-04T11:00:00.000Z" },
    });
    const working = {
      stories: { "2-1": story("in_review", "sam"), "2-2": story("in_progress", "sam") },
      checkpoints: { [refused.id]: refused, [done.id]: done },
    };
    expect(nextStep(state(working), ALL_DOCS, BUILD)).toMatchObject({
      step: "build",
      agent: "sam",
      story: "2-2",
    });
    const ready = { ...working, stories: { "2-1": story("in_review", "sam") } };
    expect(nextStep(state(ready), ALL_DOCS, BUILD)).toMatchObject({
      step: "changes_requested",
      agent: "izzy",
      checkpoint: refused.id,
    });
    // Its opener no longer active: the creator.
    const ghost = { ...refused, opened_by: "ghost" };
    const orphan = { ...ready, checkpoints: { [refused.id]: ghost, [done.id]: done } };
    expect(nextStep(state(orphan), ALL_DOCS, BUILD)).toMatchObject({
      step: "changes_requested",
      you: true,
      agent: null,
    });
  });

  it("sends a rejected end of phase back like a request for changes", () => {
    const docs = { kinds: ["brief"] as NextDocs["kinds"], stories: [] };
    const rejected = phaseEnd("framing", 1, {
      resolution: { decision: "rejected", waiver_until: null, at: "2026-10-03T01:00:00Z" },
    });
    expect(
      nextStep(state({ checkpoints: { [rejected.id]: rejected } }), docs, CONFIG),
    ).toMatchObject({ step: "changes_requested", agent: "iris", checkpoint: rejected.id });
  });

  it("counts the latest approval of a story, and any other status as open", () => {
    const approved = (id: string, at: string) =>
      checkpoint(id, {
        status: "resolved",
        story: "2-1",
        blocks_lifted: true,
        resolution: { decision: "approved", waiver_until: null, at },
      });
    const built = closed("framing", "planning", "design");
    const since = "2026-10-03T03:00:00.000Z";
    const projection = {
      stories: { "2-1": story("in_review", "sam", "2026-10-03T00:00:00.000Z") },
      checkpoints: {
        "G-OLD01": approved("G-OLD01", "2026-10-03T00:30:00.000Z"),
        "G-NEW01": approved("G-NEW01", "2026-10-04T11:00:00.000Z"),
        ...built,
      },
    };
    expect(Date.parse(since)).toBeLessThan(Date.parse("2026-10-04T11:00:00.000Z"));
    expect(nextStep(state(projection), ALL_DOCS, CONFIG)).toMatchObject({
      step: "phase_end",
      phase: "build",
    });
    const odd = { stories: { "2-1": story("ready", "sam") } };
    expect(nextStep(state(odd), ALL_DOCS, BUILD)).toMatchObject({
      step: "build",
      agent: "sam",
      story: "2-1",
    });
  });

  it("never takes a waived release or publication for an approval", () => {
    const waived = (type: string) =>
      checkpoint("G-WWWWW", {
        type,
        status: "waived",
        resolution: {
          decision: "waived",
          waiver_until: new Date(NOW + DAY).toISOString(),
          at: "2026-10-03T10:00:00.000Z",
        },
      });
    const built = closed("framing", "planning", "design", "build");
    expect(
      nextStep(state({ checkpoints: { ...built, "G-WWWWW": waived("release") } }), ALL_DOCS, CONFIG)
        .step,
    ).toBe("delivery");
    const delivered = closed("framing", "planning", "design", "build", "delivery");
    expect(
      nextStep(
        state({ checkpoints: { ...delivered, "G-WWWWW": waived("publication") } }),
        ALL_DOCS,
        CONFIG,
      ).step,
    ).toBe("launch");
  });

  it("closes the launch on a publication approved during it, not before", () => {
    const delivered = closed("framing", "planning", "design", "build", "delivery");
    const publication = (at: string) =>
      checkpoint("G-PUBLI", {
        type: "publication",
        status: "resolved",
        resolution: { decision: "approved", waiver_until: null, at },
      });
    const before = { ...delivered, "G-PUBLI": publication("2026-10-03T04:00:00.000Z") };
    expect(nextStep(state({ checkpoints: before }), ALL_DOCS, CONFIG).step).toBe("launch");
    const after = { ...delivered, "G-PUBLI": publication("2026-10-03T06:00:00.000Z") };
    expect(nextStep(state({ checkpoints: after }), ALL_DOCS, CONFIG)).toMatchObject({
      step: "phase_end",
      phase: "launch",
      agent: "julien",
    });
  });

  it("goes from framing to launch in launch-only, and to build in prototype", () => {
    const docs = { kinds: ["brief"] as NextDocs["kinds"], stories: [] };
    const framed = state({ checkpoints: closed("framing") });
    const launchOnly = PROFILE_PRESETS["launch-only"];
    expect(
      nextStep(framed, docs, { ...CONFIG, domains: launchOnly.domains, phases: launchOnly.phases }),
    ).toMatchObject({ step: "launch", phase: "launch", agent: "julien" });
    const prototype = PROFILE_PRESETS.prototype;
    expect(
      nextStep(framed, docs, { ...CONFIG, domains: prototype.domains, phases: prototype.phases }),
    ).toMatchObject({ step: "breakdown", phase: "build", agent: "izzy" });
  });

  it("warns about an end of phase left aside", () => {
    const docs = { kinds: [] as NextDocs["kinds"], stories: [] };
    const stray = phaseEnd("design", 1, { status: "open", resolution: null });
    const step = nextStep(state({ checkpoints: { [stray.id]: stray } }), docs, CONFIG);
    expect(step).toMatchObject({ step: "framing", phase: "framing" });
    expect(step.stray).toEqual([
      { checkpoint: stray.id, phase: "design", reason: "open_not_current" },
    ]);
  });

  it("puts a blocking checkpoint first, cited first, with the review command", () => {
    const projection = {
      checkpoints: {
        "G-AAAAA": checkpoint("G-AAAAA"),
        "G-BBBBB": checkpoint("G-BBBBB", { blocks: BLOCKS, story: "2-6" }),
      },
      humans: { "human:x": { device: "human:x", trust: "pending" } },
    };
    const step = nextStep(state(projection, { ...SYNCED, manifest: false }), ALL_DOCS, CONFIG);
    expect(step).toMatchObject({
      step: "validation",
      you: true,
      agent: null,
      command: "npx agentplugged review G-BBBBB",
      checkpoint: "G-BBBBB",
      story: "2-6",
      pending_keys: ["human:x"],
      phase: "framing",
    });
    expect(step.waiting.map((item) => item.id)).toEqual(["G-BBBBB", "G-AAAAA"]);
  });

  it("puts first the checkpoint a high-risk action of an untrusted session waits on", () => {
    const projection = {
      checkpoints: {
        "G-AAAAA": checkpoint("G-AAAAA"),
        "G-BBBBB": checkpoint("G-BBBBB", { source: "untrusted_action", type: "permission" }),
      },
    };
    const step = nextStep(state(projection), NO_DOCS, CONFIG);
    expect(step).toMatchObject({
      step: "validation",
      command: "npx agentplugged review G-BBBBB",
      checkpoint: "G-BBBBB",
    });
  });

  it("lists an open checkpoint that blocks nothing without taking the step", () => {
    const projection = { checkpoints: { "G-AAAAA": checkpoint("G-AAAAA") } };
    const step = nextStep(state(projection), NO_DOCS, CONFIG);
    expect(step).toMatchObject({ step: "framing", agent: "iris" });
    expect(step.waiting.map((item) => item.id)).toEqual(["G-AAAAA"]);
  });

  it("treats a waiver past its deadline as blocking again", () => {
    const waived = (until: number) =>
      checkpoint("G-CCCCC", {
        status: "waived",
        blocks: BLOCKS,
        resolution: {
          decision: "waived",
          waiver_until: new Date(until).toISOString(),
          at: "2026-10-01T00:00:00Z",
        },
      });
    const past = { checkpoints: { "G-CCCCC": waived(NOW - DAY) } };
    expect(nextStep(state(past), ALL_DOCS, CONFIG)).toMatchObject({
      step: "validation",
      command: "npx agentplugged review G-CCCCC",
    });
    const future = { checkpoints: { "G-CCCCC": waived(NOW + DAY) } };
    const step = nextStep(state(future), ALL_DOCS, CONFIG);
    expect(step.step).toBe("phase_end");
    expect(step.waiting).toEqual([]);
  });

  it("puts a refused checkpoint whose blocks still apply first, to its agent", () => {
    const refused = (lifted: boolean, decision = "changes_requested") => ({
      checkpoints: {
        "G-EEEEE": checkpoint("G-EEEEE", {
          status: "resolved",
          story: "2-6",
          blocks: BLOCKS,
          blocks_lifted: lifted,
          resolution: { decision, waiver_until: null, at: "2026-10-04T11:00:00Z" },
        }),
      },
    });
    expect(nextStep(state(refused(false)), ALL_DOCS, CONFIG)).toMatchObject({
      step: "changes_requested",
      you: false,
      agent: "iris",
      checkpoint: "G-EEEEE",
      story: "2-6",
      command: "npx agentplugged history --story 2-6",
      waiting: [],
    });
    expect(nextStep(state(refused(false, "rejected")), ALL_DOCS, CONFIG).step).toBe(
      "changes_requested",
    );
    // Superseded by an approved checkpoint: its blocks no longer apply.
    expect(nextStep(state(refused(true)), ALL_DOCS, CONFIG).step).toBe("phase_end");
  });

  it("ignores approved checkpoints", () => {
    const projection = {
      checkpoints: {
        "G-DDDDD": checkpoint("G-DDDDD", {
          status: "resolved",
          blocks: BLOCKS,
          blocks_lifted: true,
          resolution: { decision: "approved", waiver_until: null, at: "2026-10-04T11:00:00Z" },
        }),
      },
    };
    expect(nextStep(state(projection), ALL_DOCS, CONFIG).step).toBe("phase_end");
  });

  it("asks to endorse a creator's key waiting for it, and names it", () => {
    const projection = {
      humans: {
        "human:root": { device: "human:root", trust: "root" },
        "human:new": { device: "human:new", trust: "pending" },
      },
    };
    const step = nextStep(state(projection, { ...SYNCED, manifest: false }), ALL_DOCS, CONFIG);
    expect(step).toMatchObject({
      step: "key_endorsement",
      you: true,
      command: "npx agentplugged key endorse",
      pending_keys: ["human:new"],
    });
  });

  it("asks for a sync when the method is not synced", () => {
    expect(
      nextStep(
        state({}, { ...SYNCED, manifest: false, missing: ["claude-code"] }),
        NO_DOCS,
        CONFIG,
      ),
    ).toMatchObject({ step: "sync", you: true, sync: "never", command: "npx agentplugged sync" });
    expect(
      nextStep(state({}, { ...SYNCED, missing: ["claude-code", "cursor"] }), NO_DOCS, CONFIG),
    ).toMatchObject({
      step: "sync",
      sync: "tool_missing",
      missing_tools: ["claude-code", "cursor"],
    });
    expect(nextStep(state({}, { ...SYNCED, recorded: null }), NO_DOCS, CONFIG)).toMatchObject({
      step: "sync",
      sync: "stale",
    });
    expect(nextStep(state(), NO_DOCS, { ...CONFIG, tools: [] })).toMatchObject({
      step: "sync",
      sync: "no_tool",
      command: null,
    });
  });

  it("decides the sync need from the fingerprints", () => {
    expect(syncNeed(SYNCED, TOOLS)).toBeUndefined();
    expect(syncNeed({ ...SYNCED, current: "b" }, TOOLS)).toBe("stale");
    expect(syncNeed(SYNCED, [])).toBe("no_tool");
  });

  it("orders story ids by epic, then story", () => {
    expect(["2-10", "10-1", "2-9", "1-2"].sort(byStoryId)).toEqual(["1-2", "2-9", "2-10", "10-1"]);
  });
});

// --- the fingerprint of what sync generates from ------------------------------------------------

describe("syncInputsFingerprint", () => {
  const base = () =>
    new MemoryFiles({
      ".agentplugged/method.yaml": "format_version: 2\nengine_version: 1.0.0\ntools: [codex]\n",
      ".agentplugged/agents/iris/SKILL.md": SHIPPED_IRIS,
      ".agentplugged/agents/iris/references/notes.md": "notes",
      ".agentplugged/skills/brief/SKILL.md": "skill",
      ".agentplugged/overrides/agents/iris.yaml": "icon: x\n",
      ".agentplugged/docs/prd.md": "prd",
    });

  it("changes with the agents, skills, customisations and settings, not with the rest", async () => {
    const files = base();
    const first = await syncInputsFingerprint(files);
    expect(await syncInputsFingerprint(files)).toBe(first);
    // An identical rewrite, a document or an unrelated setting: unchanged.
    files.seed(".agentplugged/agents/iris/SKILL.md", SHIPPED_IRIS);
    files.seed(".agentplugged/docs/prd.md", "prd 2");
    files.seed(
      ".agentplugged/method.yaml",
      "format_version: 2\nengine_version: 1.0.0\ntools: [codex]\n",
    );
    expect(await syncInputsFingerprint(files)).toBe(first);
    const changes: Array<(files: MemoryFiles) => void> = [
      // The pinned engine is written in the generated texts.
      (f) =>
        f.seed(
          ".agentplugged/method.yaml",
          "format_version: 2\nengine_version: 1.0.1\ntools: [codex]\n",
        ),
      (f) => f.seed(".agentplugged/agents/iris/SKILL.md", `${SHIPPED_IRIS}\nMore.\n`),
      (f) => f.files.delete(".agentplugged/agents/iris/references/notes.md"),
      (f) => f.seed(".agentplugged/skills/brief/SKILL.md", "skill 2"),
      (f) => f.seed(".agentplugged/overrides/agents/iris.yaml", "icon: y\n"),
      (f) =>
        f.seed(
          ".agentplugged/method.yaml",
          "format_version: 2\nengine_version: 1.0.0\ntools: [cursor]\n",
        ),
    ];
    for (const change of changes) {
      const other = base();
      change(other);
      expect(await syncInputsFingerprint(other)).not.toBe(first);
    }
  });
});

// --- the command ------------------------------------------------------------------------------

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(9));

const DOC = (kind: string, id: string) =>
  `---\nid: ${id}\nkind: ${kind}\nowner: iris\n---\n# ${id}\n`;

/** A shipped agent built on the sample one. */
function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

async function product(
  preset: "new-product" | "maintenance" = "new-product",
  /** Files already there before `init`, and Zoé shipped too. */
  options: {
    readonly before?: Record<string, string>;
    readonly zoe?: boolean;
    readonly maya?: boolean;
  } = {},
) {
  const files = new MemoryFiles(options.before);
  let clock = NOW;
  const now = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...shippedAgent("stella", "Stella", "ux", "planning"),
      ...shippedAgent("izzy", "Izzy", "product", "build"),
      ...shippedAgent("quentin", "Quentin", "quality", "build"),
      ...(options.zoe === true ? shippedAgent("zoe", "Zoé", "docs", "build") : {}),
      ...(options.maya === true ? shippedAgent("maya", "Maya", "product", "planning") : {}),
    }),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
  };
  const init = await initCommand.run(human, { profile: resolveProfile(preset) });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const sync = async () => {
    const synced = await syncCommand.run(human, {});
    if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  };
  await sync();
  const agent: CommandContext = { ...human, actor: "agent", human: undefined };
  const registry = createCommandRegistry();
  const run = async (name: string, input: Record<string, unknown>) => {
    const result = await registry.run(name, agent, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`);
    return result.value as RecordedEvent;
  };
  // A read command of the CLI, which an agent's shell may run too: no key is given to it.
  const reader: CommandContext = { ...human, human: undefined };
  const next = async (context: CommandContext = reader) => {
    const result = await registry.run("next", context, {});
    if (!result.ok) throw new Error(`next failed: ${result.error.code}`);
    return result.value as NextResult;
  };
  const allDocs = () => {
    for (const name of ["brief", "prd", "ux", "architecture"]) {
      files.seed(`.agentplugged/docs/${name}.md`, DOC(name, name));
    }
    files.seed(".agentplugged/epics/epic-2.md", DOC("epic", "epic-2"));
  };
  /**
   * Opens the end of `phase` by the agent that closes it here (Iris, Stella without Maya, the main
   * session without Alex, Izzy) and approves it at the terminal.
   */
  const closers: Record<string, string> = {
    framing: "iris",
    planning: "stella",
    design: "main",
    build: "izzy",
  };
  const close = async (...phases: PhaseId[]) => {
    for (const phase of phases) {
      const opened = await run("open_checkpoint", {
        agent: closers[phase] ?? "main",
        type: "phase_end",
        phase,
        risk: "low",
        title: `End of ${phase}`,
        summary: `The deliverables of ${phase} are ready.`,
      });
      const answered = await registry.run("review", human, {
        action: "resolve",
        checkpoint: opened.checkpoint,
        decision: "approved",
      });
      if (!answered.ok) throw new Error(`review failed: ${answered.error.code}`);
    }
  };
  return { files, journal, human, agent, reader, run, next, allDocs, registry, sync, close };
}

describe("next", () => {
  it("proposes Iris for framing after init and sync", async () => {
    const { next, human } = await product();
    expect(await next(human)).toMatchObject({
      step: "framing",
      you: false,
      agent: "iris",
      agent_name: "Iris",
      tool: "claude-code",
      waiting: [],
      command: null,
      phase: "framing",
    });
  });

  it("closes a phase only through its end, in order, then moves to the next one", async () => {
    const { next, agent, registry, human, files } = await product();
    const open = (phase: string, extra: Record<string, unknown> = {}, by = "iris") =>
      registry.run("open_checkpoint", agent, {
        agent: by,
        type: "phase_end",
        phase,
        risk: "low",
        title: `End of ${phase}`,
        summary: "Ready.",
        ...extra,
      });
    // Iris does not close the design; without Alex, the main session does, in its turn only.
    const notCloser = await open("design");
    expect(!notCloser.ok && notCloser.error.code).toBe(ErrorCode.AGENT_NOT_CLOSER);
    expect(!notCloser.ok && notCloser.error.details).toEqual({
      agent: "iris",
      phase: "design",
      closers: ["main"],
    });
    const byLea = await open("framing", {}, "stella");
    expect(!byLea.ok && byLea.error.details).toMatchObject({ closers: ["iris"] });
    const later = await open("design", {}, "main");
    expect(!later.ok && later.error.code).toBe(ErrorCode.PHASE_NOT_CURRENT);
    expect(!later.ok && later.error.details).toMatchObject({
      phase: "design",
      current: "framing",
      reason: "not_current",
    });
    for (const wrong of [{ story: "2-1" }, { blocks: BLOCKS }, { phase: undefined }]) {
      const refused = await open("framing", wrong);
      expect(!refused.ok && refused.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    }
    const phaseOnDocument = await registry.run("open_checkpoint", agent, {
      agent: "iris",
      type: "document",
      phase: "framing",
      risk: "low",
      title: "Brief",
      summary: "Read it.",
    });
    expect(!phaseOnDocument.ok && phaseOnDocument.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    files.seed(".agentplugged/docs/brief.md", DOC("brief", "brief"));
    expect(await next()).toMatchObject({ step: "phase_end", agent: "iris", phase: "framing" });
    const opened = await open("framing");
    if (!opened.ok) throw new Error(opened.error.code);
    const id = (opened.value as RecordedEvent).checkpoint as string;
    const twice = await open("framing");
    expect(!twice.ok && twice.error.details).toMatchObject({
      reason: "already_open",
      checkpoint: id,
    });
    expect(!twice.ok && twice.error.message_key).toBe("error.phase_end_already_open");
    expect(await next()).toMatchObject({
      step: "phase_review",
      checkpoint: id,
      command: `npx agentplugged review ${id}`,
    });
    const viewed = await registry.run("get_state", agent, { full: true });
    const view = viewed.ok ? (viewed.value as AgentStateView) : undefined;
    expect(view?.phase).toMatchObject({ current: "framing", status: "in_review", since: null });
    expect(view?.checkpoints[id]).toMatchObject({ type: "phase_end", phase: "framing" });
    const answered = await registry.run("review", human, {
      action: "resolve",
      checkpoint: id,
      decision: "approved",
    });
    expect(answered.ok).toBe(true);
    expect(await next()).toMatchObject({ step: "ux_spec", phase: "planning", agent: "stella" });
    const after = await registry.run("get_state", agent, { full: true });
    const phase = after.ok ? (after.value as AgentStateView).phase : undefined;
    expect(phase?.current).toBe("planning");
    expect(phase?.phases.slice(0, 2)).toEqual([
      { id: "framing", status: "done" },
      { id: "planning", status: "in_progress" },
    ]);
  });

  it("puts a checkpoint that blocks a story first", async () => {
    const { next, run } = await product();
    const opened = await run("open_checkpoint", {
      agent: "iris",
      type: "story",
      risk: "low",
      title: "Story 2-6 done",
      summary: "Review the work on 2-6.",
      story: "2-6",
      blocks: BLOCKS,
    });
    const id = opened.checkpoint as string;
    expect(await next()).toMatchObject({
      step: "validation",
      you: true,
      agent: null,
      command: `npx agentplugged review ${id}`,
      waiting: [{ id, title: "Story 2-6 done", type: "story", risk: "low" }],
    });
  });

  it("finds documents by their kind, or by their name", async () => {
    const { next, files, close } = await product();
    files.seed(".agentplugged/docs/product-brief.md", DOC("brief", "product-brief"));
    files.seed(".agentplugged/docs/PRD.md", "# Requirements, without a header\n");
    expect(await next()).toMatchObject({ step: "phase_end", agent: "iris" });
    await close("framing");
    expect(await next()).toMatchObject({ step: "ux_spec", agent: "stella", agent_name: "Stella" });
  });

  it("calls Quentin for a story in review, and leaves it once its checkpoint is approved", async () => {
    const { next, run, allDocs, human, registry, close } = await product();
    allDocs();
    await close("framing", "planning", "design");
    await run("update_story", { agent: "iris", story: "2-3", status: "in_review" });
    expect(await next()).toMatchObject({ step: "review", agent: "quentin", story: "2-3" });
    const opened = await run("open_checkpoint", {
      agent: "quentin",
      type: "story",
      risk: "low",
      title: "Story 2-3 done",
      summary: "Validate 2-3.",
      story: "2-3",
      blocks: [{ action: "story.complete", story: "2-3" }],
    });
    const answered = await registry.run("review", human, {
      action: "resolve",
      checkpoint: opened.checkpoint,
      decision: "approved",
    });
    expect(answered.ok).toBe(true);
    expect(await next()).toMatchObject({ step: "phase_end", phase: "build", agent: "izzy" });
  });

  it("reads the stories without a status from their header or their name", async () => {
    const { next, files, allDocs, run, close } = await product();
    allDocs();
    await close("framing", "planning", "design");
    expect(await next()).toMatchObject({ step: "breakdown", agent: "izzy" });
    files.seed(".agentplugged/stories/2-4-login.md", DOC("story", "login"));
    // A story never validated (and outside the story contract) cannot enter a sprint: its
    // breakdown goes back to Izzy rather than a sprint planning that could only fail.
    expect(await next()).toMatchObject({ step: "breakdown", agent: "izzy" });
    await run("update_story", { agent: "iris", story: "2-4", status: "blocked" });
    expect(await next()).toMatchObject({ step: "story_blocked", agent: "iris", story: "2-4" });
  });

  it("skips the disabled phases in the maintenance profile", async () => {
    const { next } = await product("maintenance");
    expect(await next()).toMatchObject({ step: "none", agent: null, phase: "build" });
  });

  it("asks for a sync when a tool lacks its files, or its inputs changed", async () => {
    const { next, files, sync } = await product();
    files.removeDir(".claude");
    expect(await next()).toMatchObject({
      step: "sync",
      sync: "tool_missing",
      missing_tools: ["claude-code"],
    });
    await sync();
    expect((await next()).step).toBe("framing");
    // An identical rewrite changes nothing.
    const yaml = ".agentplugged/agents/iris/agent.yaml";
    files.seed(yaml, files.files.get(yaml) ?? "");
    expect((await next()).step).toBe("framing");
    files.seed(".agentplugged/agents/iris/references/new.md", "More.\n");
    expect(await next()).toMatchObject({ step: "sync", sync: "stale" });
    await sync();
    expect((await next()).step).toBe("framing");
    files.files.delete(".agentplugged/agents/iris/references/new.md");
    expect(await next()).toMatchObject({ step: "sync", sync: "stale" });
    await sync();
    expect(JSON.parse(files.files.get(SYNC_MANIFEST_PATH) ?? "{}").inputs).toBe(
      await syncInputsFingerprint(files),
    );
  });

  it("works without a Git repository, and writes nothing", async () => {
    const { files, reader, registry } = await product();
    const noRepo = new Proxy({} as StateStore, {
      get: () => async () => {
        throw new AgentPluggedError(ErrorCode.NOT_A_GIT_REPO, "error.not_a_git_repo", {});
      },
    });
    files.writes.length = 0;
    const result = await registry.run("next", { ...reader, journal: noRepo }, {});
    expect(result.ok && (result.value as NextResult).step).toBe("framing");
    expect(files.writes).toEqual([]);
  });

  it("refuses any input and a folder without the method", async () => {
    const { reader, registry } = await product();
    const extra = await registry.run("next", reader, { json: true });
    expect(!extra.ok && extra.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    const empty = await registry.run("next", { ...reader, files: new MemoryFiles() }, {});
    expect(!empty.ok && empty.error.code).toBe(ErrorCode.METHOD_NOT_INSTALLED);
  });
});

describe("next: the knowledge base of an existing product", () => {
  const EXISTING: NextConfig = { ...CONFIG, agents: { ...AGENTS, zoe: "Zoé" }, existing: true };

  it("calls Zoé first while the map of the base is missing", () => {
    expect(nextStep(state(), NO_DOCS, EXISTING)).toMatchObject({
      step: "knowledge_base",
      agent: "zoe",
      agent_name: "Zoé",
      you: false,
      phase: "framing",
    });
    // Before the work of any phase, the build included.
    expect(nextStep(state(), ALL_DOCS, { ...EXISTING, phases: ["build"] }).step).toBe(
      "knowledge_base",
    );
  });

  it("moves on once the map exists", () => {
    const docs = { ...NO_DOCS, knowledge_base: true };
    expect(nextStep(state(), docs, EXISTING)).toMatchObject({ step: "framing", agent: "iris" });
  });

  it("proposes nothing for a new product, without the docs domain or without Zoé", () => {
    expect(nextStep(state(), NO_DOCS, { ...EXISTING, existing: false }).step).toBe("framing");
    const noDocs = DOMAIN_IDS.filter((domain) => domain !== "docs");
    expect(nextStep(state(), NO_DOCS, { ...EXISTING, domains: noDocs }).step).toBe("framing");
    expect(nextStep(state(), NO_DOCS, { ...EXISTING, agents: AGENTS }).step).toBe("framing");
  });

  it("keeps what waits for the creator first", () => {
    const blocking = checkpoint("G-AAAAAAAAAA", { blocks: BLOCKS });
    expect(
      nextStep(state({ checkpoints: { [blocking.id]: blocking } }), NO_DOCS, EXISTING).step,
    ).toBe("validation");
    const stale = { ...SYNCED, current: "b" };
    expect(nextStep(state({}, stale), NO_DOCS, EXISTING).step).toBe("sync");
    const end = checkpoint("G-BBBBBBBBBB", { type: "phase_end", phase: "framing" });
    expect(nextStep(state({ checkpoints: { [end.id]: end } }), NO_DOCS, EXISTING).step).toBe(
      "phase_review",
    );
  });

  it("never outranks a refused end, a story under way or the delivery", () => {
    const docs = { kinds: ["brief"] as NextDocs["kinds"], stories: [] };
    const refused = phaseEnd("framing", 1, {
      resolution: { decision: "changes_requested", waiver_until: null, at: "2026-10-03T01:00:00Z" },
    });
    expect(
      nextStep(state({ checkpoints: { [refused.id]: refused } }), docs, EXISTING),
    ).toMatchObject({ step: "changes_requested", agent: "iris" });
    for (const status of ["in_progress", "in_review", "blocked"]) {
      const step = nextStep(state({ stories: { "2-1": story(status, "sam") } }), ALL_DOCS, {
        ...EXISTING,
        phases: ["build"],
      });
      expect(step.step, status).not.toBe("knowledge_base");
      expect(step.story, status).toBe("2-1");
    }
    const delivery = state({ checkpoints: closed("framing", "planning", "design", "build") });
    expect(nextStep(delivery, ALL_DOCS, EXISTING)).toMatchObject({
      step: "delivery",
      agent: "omar",
    });
  });

  it("waits for the creator's review of the base, or answer to Zoé's question", () => {
    const review = checkpoint("G-CCCCCCCCCC", {
      type: "document",
      opened_by: "zoe",
      documents: [{ path: ".agentplugged/docs/index.md", branch: "kb", blob_sha: "a".repeat(40) }],
    });
    const other = checkpoint("G-DDDDDDDDDD", { type: "document", opened_by: "zoe" });
    const both = { checkpoints: { [other.id]: other, [review.id]: review } };
    // The map is on Zoé's branch, not here: the review waits, nothing is generated again.
    for (const docs of [NO_DOCS, { ...NO_DOCS, knowledge_base: true }]) {
      expect(nextStep(state(both), docs, EXISTING)).toMatchObject({
        step: "knowledge_base_review",
        you: true,
        agent: null,
        checkpoint: review.id,
        command: `npx agentplugged review ${review.id}`,
      });
    }
    const question = checkpoint("G-EEEEEEEEEE", { type: "decision", opened_by: "zoe" });
    expect(
      nextStep(state({ checkpoints: { [question.id]: question } }), NO_DOCS, EXISTING),
    ).toMatchObject({
      step: "knowledge_base_decision",
      you: true,
      checkpoint: question.id,
      command: `npx agentplugged review ${question.id}`,
    });
    // Another agent's question, or a document of Zoé's without the map: Zoé generates.
    const iris = checkpoint("G-FFFFFFFFFF", { type: "decision", opened_by: "iris" });
    const unrelated = { checkpoints: { [iris.id]: iris, [other.id]: other } };
    expect(nextStep(state(unrelated), NO_DOCS, EXISTING).step).toBe("knowledge_base");
  });

  it("finds the map only in a non-empty file, here or on the main branch", async () => {
    const before = { "go.mod": "module ada\n" };
    const { next, files, reader } = await product("new-product", { before, zoe: true });
    files.seed(".agentplugged/docs/index.md", "  \n");
    expect((await next()).step).toBe("knowledge_base");
    files.files.delete(".agentplugged/docs/index.md");
    files.dirs.add(".agentplugged/docs/index.md");
    expect((await next()).step).toBe("knowledge_base");
    files.dirs.delete(".agentplugged/docs/index.md");
    const mainBranch = (text: string | undefined) => ({
      read: async () => ({ found: true as const, branch: "origin/main", text }),
    });
    expect((await next({ ...reader, mainBranch: mainBranch("# Base\n") })).step).toBe("framing");
    expect((await next({ ...reader, mainBranch: mainBranch(undefined) })).step).toBe(
      "knowledge_base",
    );
    const failing = { read: async () => Promise.reject(new Error("git: timeout")) };
    expect((await next({ ...reader, mainBranch: failing })).step).toBe("knowledge_base");
  });

  it("is proposed after init in a folder that held the product, until index.md exists", async () => {
    const before = { "package.json": "{}\n", "src/main.ts": "export {};\n" };
    const { next, files } = await product("new-product", { before, zoe: true });
    expect(files.files.get(".agentplugged/method.yaml")).toContain("origin: existing");
    expect(await next()).toMatchObject({ step: "knowledge_base", agent: "zoe" });
    files.seed(".agentplugged/docs/index.md", DOC("note", "kb-index"));
    expect(await next()).toMatchObject({ step: "framing", agent: "iris" });
  });

  it("is not proposed after init in an empty folder, nor when the creator says new", async () => {
    const empty = await product("new-product", { zoe: true });
    expect(empty.files.files.get(".agentplugged/method.yaml")).not.toContain("origin");
    expect((await empty.next()).step).toBe("framing");
    // The maintenance profile counts as an existing product while `origin` is absent.
    const maintenance = await product("maintenance", { zoe: true });
    expect(maintenance.files.files.get(".agentplugged/method.yaml")).not.toContain("origin");
    expect((await maintenance.next()).step).toBe("knowledge_base");
    const config = maintenance.files.files.get(".agentplugged/method.yaml") ?? "";
    maintenance.files.seed(".agentplugged/method.yaml", `${config}origin: new\n`);
    expect((await maintenance.next()).step).not.toBe("knowledge_base");
  });
});

describe("a structuring document and the end of its phase", () => {
  const PRD = {
    path: ".agentplugged/docs/prd.md",
    branch: "main",
    blob_sha: "c".repeat(40),
  };
  const UX = { ...PRD, path: ".agentplugged/docs/ux.md", blob_sha: "d".repeat(40) };

  /** A product in the planning phase with Maya and Stella active, the PRD and the UX written. */
  async function planning() {
    const p = await product("new-product", { maya: true });
    await p.close("framing");
    p.allDocs();
    const open = async (fields: Record<string, unknown>) =>
      p.registry.run("open_checkpoint", p.agent, {
        agent: "maya",
        risk: "low",
        title: "Document",
        summary: "Ready.",
        ...fields,
      });
    const review = (checkpoint: string, decision: string, note?: string) =>
      p.registry.run("review", p.human, {
        action: "resolve",
        checkpoint,
        decision,
        ...(note === undefined ? {} : { note }),
      });
    const idOf = (result: Awaited<ReturnType<typeof open>>) => {
      if (!result.ok) throw new Error(result.error.code);
      return (result.value as RecordedEvent).checkpoint as string;
    };
    return { ...p, open, review, idOf };
  }

  it("lets Stella open the end of planning although Maya is active", async () => {
    const { open } = await planning();
    const end = await open({
      agent: "stella",
      type: "phase_end",
      phase: "planning",
      documents: [PRD, UX],
    });
    expect(end.ok).toBe(true);
  });

  it("refuses the end of the phase while a document point of the phase is open", async () => {
    const { open, review, idOf, next } = await planning();
    const point = idOf(await open({ type: "document", documents: [PRD] }));
    const refused = await open({ type: "phase_end", phase: "planning", documents: [PRD, UX] });
    expect(!refused.ok && refused.error.code).toBe(ErrorCode.DOCUMENT_REVIEW_OPEN);
    expect(!refused.ok && refused.error.details).toEqual({ phase: "planning", checkpoint: point });
    expect(!refused.ok && refused.error.message_key).toBe("error.document_review_open");
    // Not a step of the agents: the document point is the creator's to answer.
    expect(await next()).toMatchObject({ step: "validation", you: true, checkpoint: point });
    expect((await review(point, "approved")).ok).toBe(true);
    const end = await open({ type: "phase_end", phase: "planning", documents: [PRD, UX] });
    expect(end.ok).toBe(true);
  });

  it("sends a refused document point back to its author until a new point supersedes it", async () => {
    const { open, review, idOf, next } = await planning();
    const point = idOf(await open({ type: "document", documents: [PRD] }));
    expect((await review(point, "changes_requested", "Add the glossary.")).ok).toBe(true);
    expect(await next()).toMatchObject({
      step: "changes_requested",
      agent: "maya",
      checkpoint: point,
    });
    // Reopened with `supersedes` (no story): the step goes away, the new point is the creator's.
    const again = idOf(await open({ type: "document", documents: [PRD], supersedes: point }));
    expect((await next()).step).not.toBe("changes_requested");
    expect((await review(again, "approved")).ok).toBe(true);
    expect((await next()).step).not.toBe("changes_requested");
  });

  it("does not take a sprint, a story or a knowledge-base review for a structuring document", async () => {
    const { open, next } = await planning();
    const other = await open({
      type: "document",
      documents: [{ ...PRD, path: ".agentplugged/docs/index.md" }],
    });
    expect(other.ok).toBe(true);
    const end = await open({ type: "phase_end", phase: "planning", documents: [PRD, UX] });
    expect(end.ok).toBe(true);
    expect((await next()).step).toBe("phase_review");
  });

  it("refuses Noah the right to open any checkpoint (he asks on an open one only)", async () => {
    const { open } = await planning();
    const refused = await open({
      agent: "noah",
      type: "decision",
      title: "Choice",
      summary: "a or b?",
      options: [
        { id: "a", label: "A", consequence: "x" },
        { id: "b", label: "B", consequence: "y" },
      ],
      recommendation: "b",
    });
    expect(!refused.ok && refused.error.code).toBe(ErrorCode.ROLE_FORBIDDEN);
  });
});
