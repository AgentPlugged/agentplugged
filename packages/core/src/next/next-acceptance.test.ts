import { DOMAIN_IDS } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CheckpointState,
  type NextConfig,
  type NextDocs,
  type NextState,
  nextStep,
  type StoryState,
  type SyncFreshness,
} from "../index.js";
import { answered, checkpointState } from "../testing/checkpoint-state.js";
import { ACCEPTANCE_PATH, AFTER_LAUNCH_PATH } from "./next.js";

/** The acceptance run before a release, and the look back a week after a launch. */

const DAY = 24 * 60 * 60 * 1000;
const SYNCED: SyncFreshness = { manifest: true, missing: [], recorded: "a", current: "a" };
const at = (day: number, hour = 12) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();
const NOW = Date.UTC(2026, 9, 20, 12);

const CONFIG: NextConfig = {
  domains: DOMAIN_IDS,
  phases: ["build", "delivery", "launch"],
  tools: ["claude-code"],
  preferred: {},
  agents: { izzy: "Izzy", omar: "Omar", quentin: "Quentin", iris: "Iris", julien: "Julien" },
};

const built = answered("G-BUILD", "approved", at(1), [], {
  type: "phase_end",
  phase: "build",
  opened_by: "izzy",
});

const report = (
  path: string,
  id: string,
  decision: "approved" | "changes_requested",
  day: number,
) =>
  answered(id, decision, at(day, 13), [[path, "a".repeat(40)]], {
    opened_by: id.startsWith("G-AFTER") ? "iris" : "quentin",
    opened_at: at(day),
  });

function state(checkpoints: readonly CheckpointState[], now = NOW): NextState {
  return {
    projection: {
      checkpoints: Object.fromEntries(checkpoints.map((c) => [c.id, c])),
      stories: {},
    },
    now,
    sync: SYNCED,
  };
}

const docs: NextDocs = {
  kinds: ["brief", "prd", "architecture"],
  stories: [],
  knowledge_base: false,
};

describe("next: the acceptance run of the delivery phase", () => {
  it("calls Quentin before Omar prepares the release", () => {
    expect(nextStep(state([built]), docs, CONFIG)).toMatchObject({
      step: "acceptance",
      agent: "quentin",
      you: false,
    });
  });

  it("hands over to Omar once the creator approved the acceptance report", () => {
    const passed = report(ACCEPTANCE_PATH, "G-ACCEPT", "approved", 2);
    expect(nextStep(state([built, passed]), docs, CONFIG)).toMatchObject({
      step: "delivery",
      agent: "omar",
    });
  });

  it("calls Quentin again when the creator sent the report back", () => {
    const refused = report(ACCEPTANCE_PATH, "G-ACCEPT", "changes_requested", 2);
    expect(nextStep(state([built, refused]), docs, CONFIG).step).not.toBe("delivery");
  });

  it("waits for the creator while the report is open", () => {
    const open = checkpointState("G-ACCEPT", {
      opened_by: "quentin",
      opened_at: at(2),
      documents: [{ path: ACCEPTANCE_PATH, branch: "main", blob_sha: "a".repeat(40) }],
    });
    expect(nextStep(state([built, open]), docs, CONFIG)).toMatchObject({
      step: "validation",
      you: true,
    });
  });

  it("is skipped by the creator's word, and is not asked without Quentin", () => {
    const skipped = {
      ...state([built]),
      projection: {
        ...state([built]).projection,
        journey: { skipped: { acceptance: { reason: "no" } } },
      },
    } as unknown as NextState;
    const withoutSkip = nextStep(state([built]), docs, {
      ...CONFIG,
      agents: { izzy: "Izzy", omar: "Omar" },
    });
    expect(withoutSkip).toMatchObject({ step: "delivery", agent: "omar" });
    expect(["acceptance", "delivery"]).toContain(nextStep(skipped, docs, CONFIG).step);
  });

  it("does not take a report from an earlier delivery phase for this one", () => {
    const old = report(ACCEPTANCE_PATH, "G-OLD", "approved", 0);
    expect(nextStep(state([built, old]), docs, CONFIG).step).toBe("acceptance");
  });
});

describe("next: the look back after a launch", () => {
  const released = answered("G-REL", "approved", at(5), [], { type: "release", opened_by: "omar" });
  const launched = [built, report(ACCEPTANCE_PATH, "G-ACCEPT", "approved", 2), released];

  it("is proposed to Iris a week after the release, never before", () => {
    expect(
      nextStep(state(launched, Date.UTC(2026, 9, 5, 12) + 3 * DAY), docs, CONFIG).step,
    ).not.toBe("after_launch");
    expect(
      nextStep(state(launched, Date.UTC(2026, 9, 5, 12) + 8 * DAY), docs, CONFIG),
    ).toMatchObject({
      step: "after_launch",
      agent: "iris",
      you: false,
    });
  });

  it("is not asked twice: an open or approved look back since the launch ends it", () => {
    const later = Date.UTC(2026, 9, 5, 12) + 9 * DAY;
    const open = checkpointState("G-AFTER", {
      opened_by: "iris",
      opened_at: at(13),
      documents: [{ path: AFTER_LAUNCH_PATH, branch: "main", blob_sha: "a".repeat(40) }],
    });
    expect(nextStep(state([...launched, open], later), docs, CONFIG).step).not.toBe("after_launch");
    const done = report(AFTER_LAUNCH_PATH, "G-AFTER2", "approved", 13);
    expect(nextStep(state([...launched, done], later), docs, CONFIG).step).not.toBe("after_launch");
  });

  it("is asked again after a refused look back, and never over a story under way", () => {
    const later = Date.UTC(2026, 9, 5, 12) + 9 * DAY;
    const refused = report(AFTER_LAUNCH_PATH, "G-AFTER3", "changes_requested", 13);
    expect(nextStep(state([...launched, refused], later), docs, CONFIG).step).toBe("after_launch");
    const base = state(launched, later);
    const busy: NextState = {
      ...base,
      projection: {
        ...base.projection,
        stories: {
          "1-1": { status: "in_progress", status_by: { agent: "izzy", at: at(14) } } as StoryState,
        },
      },
    };
    expect(nextStep(busy, docs, CONFIG).step).not.toBe("after_launch");
  });

  it("needs a launch: nothing is proposed for a product that never released", () => {
    expect(nextStep(state([built], NOW + 30 * DAY), docs, CONFIG).step).not.toBe("after_launch");
  });
});
