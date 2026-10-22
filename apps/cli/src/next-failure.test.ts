import type { NextResult } from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { describe, expect, it } from "vitest";
import { formatNext, nextJson } from "./next-text.js";

/** A merge the engine refused, and the same failure twice: said in `next`, in text and in JSON. */

const refused: NextResult = {
  step: "validation",
  you: true,
  agent: null,
  agent_name: null,
  tool: null,
  waiting: [
    {
      id: "G-MERGE",
      title: "Merge story 1-1",
      type: "story_merge",
      risk: "medium",
      failure: { code: "MERGE_FAILED", reason: "base_dirty" },
    },
  ],
  command: "npx agentplugged review G-MERGE",
  story: "1-1",
  checkpoint: "G-MERGE",
  sync: null,
  missing_tools: [],
  pending_keys: [],
  phase: null,
  phases: [],
  stray: [],
  sprint: null,
  deferred: null,
  change_method: { cause: "merge", times: 2, what: "MERGE_FAILED:base_dirty" },
} as unknown as NextResult;

describe("a merge refused, in what `next` says", () => {
  it("tells a dirty base in the JSON, with the failure and the repeat", () => {
    const json = JSON.parse(nextJson(refused));
    expect(json.waiting[0].failure).toEqual({ code: "MERGE_FAILED", reason: "base_dirty" });
    expect(json.change_method).toEqual({
      cause: "merge",
      times: 2,
      what: "MERGE_FAILED:base_dirty",
    });
  });

  it("leaves both out when nothing failed", () => {
    const clean = { ...refused, waiting: [{ ...refused.waiting[0] }], change_method: undefined };
    delete (clean.waiting[0] as { failure?: unknown }).failure;
    const json = JSON.parse(nextJson(clean as NextResult));
    expect(json.waiting[0]).not.toHaveProperty("failure");
    expect(json).not.toHaveProperty("change_method");
  });

  it("tells what to do in the text, in both languages", () => {
    const fr = formatNext(createTranslator("fr"), refused);
    expect(fr).toContain("G-MERGE");
    expect(fr).toContain("changements non commités");
    expect(fr).toContain("troisième fois");
    const en = formatNext(createTranslator("en"), refused);
    expect(en).toContain("changes not committed");
    expect(en).toContain("third time");
  });
});

describe("a call the engine refused, in what `next` says", () => {
  const call = {
    ...refused,
    waiting: [],
    change_method: { cause: "action", times: 2, what: "start_story: CHECKPOINT_OPEN" },
    refused: {
      action: "start_story",
      code: "CHECKPOINT_OPEN",
      target: "1-1",
      times: 2,
      do: "Refused 2 times for the same cause: do not try it again the same way.",
    },
  } as unknown as NextResult;

  it("carries the refusal and its gesture in the JSON", () => {
    const json = JSON.parse(nextJson(call));
    expect(json.refused).toMatchObject({ action: "start_story", times: 2, target: "1-1" });
    expect(json.change_method.cause).toBe("action");
    expect(JSON.parse(nextJson({ ...call, refused: undefined } as NextResult))).not.toHaveProperty(
      "refused",
    );
  });

  it("says it in the text, in both languages", () => {
    expect(formatNext(createTranslator("fr"), call)).toContain("a refusé start_story");
    expect(formatNext(createTranslator("en"), call)).toContain("refused start_story");
  });
});
