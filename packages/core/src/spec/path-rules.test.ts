import { describe, expect, it } from "vitest";
import {
  CROWD_USERS,
  choosePath,
  MANY_USERS,
  MAX_SPEC_REQUIREMENTS,
  MAX_SPEC_STORIES,
  outgrown,
  type PathCriteria,
  readScope,
  scopeWords,
} from "./path-rules.js";

const TOOL: PathCriteria = {
  size: "small",
  users: 1,
  sensitive: [],
  integrations: 0,
  platforms: 1,
};
const with_ = (changes: Partial<PathCriteria>): PathCriteria => ({ ...TOOL, ...changes });

describe("the path the engine recommends", () => {
  it("takes the short path for a small tool nobody else uses, and says why not the full one", () => {
    expect(choosePath(TOOL)).toEqual({ path: "short", risky: false, asked: false, reasons: [] });
  });

  it("tolerates one mild signal, and calls for the full path from two", () => {
    expect(choosePath(with_({ size: "medium" })).path).toBe("short");
    expect(choosePath(with_({ users: MANY_USERS + 1 })).path).toBe("short");
    expect(choosePath(with_({ integrations: 2 })).path).toBe("short");
    expect(choosePath(with_({ platforms: 2 })).path).toBe("short");
    const two = choosePath(with_({ size: "medium", integrations: 3 }));
    expect(two).toMatchObject({ path: "full", reasons: ["size:medium", "integrations:several"] });
    expect(choosePath(with_({ users: 50, platforms: 2 })).path).toBe("full");
  });

  it("calls for the full path on one strong signal", () => {
    expect(choosePath(with_({ size: "large" }))).toMatchObject({
      path: "full",
      reasons: ["size:large"],
    });
    expect(choosePath(with_({ users: CROWD_USERS + 1 })).reasons).toEqual(["users:crowd"]);
    expect(choosePath(with_({ integrations: 4 })).reasons).toEqual(["integrations:many"]);
    expect(choosePath(with_({ platforms: 3 })).reasons).toEqual(["platforms:many"]);
  });

  it("draws the lines at the edges: 10 and 100 users, 1 and 2 and 4 services, 1 and 2 and 3 platforms", () => {
    expect(choosePath(with_({ users: MANY_USERS, platforms: 2 })).reasons).toEqual([
      "platforms:two",
    ]);
    expect(choosePath(with_({ users: CROWD_USERS, integrations: 1 })).reasons).toEqual([
      "users:many",
    ]);
    expect(choosePath(with_({ integrations: 1, platforms: 1 })).reasons).toEqual([]);
    expect(choosePath(with_({ integrations: 3 })).reasons).toEqual(["integrations:several"]);
  });

  it.each([["personal_data"], ["payment"], ["accounts"]] as const)(
    "never takes the short path for %s unless the creator asks",
    (kind) => {
      const choice = choosePath(with_({ sensitive: [kind] }));
      expect(choice).toEqual({
        path: "full",
        risky: true,
        asked: false,
        reasons: [`sensitive:${kind}`],
      });
      // Whatever else is small.
      expect(choosePath(with_({ sensitive: [kind], size: "small", users: 1 })).path).toBe("full");
    },
  );

  it("follows the creator's word, the short path for a risky product included", () => {
    const risky = with_({ sensitive: ["payment", "accounts"] });
    expect(choosePath({ ...risky, asked: "short" })).toEqual({
      path: "short",
      risky: true,
      asked: true,
      reasons: ["asked:short"],
    });
    expect(choosePath({ ...TOOL, asked: "full" })).toMatchObject({ path: "full", asked: true });
    // The word of the creator beats the signals too.
    expect(choosePath({ ...with_({ size: "large", platforms: 3 }), asked: "short" }).path).toBe(
      "short",
    );
  });
});

describe("a spec that outgrew the short path", () => {
  const SMALL = { requirements: 5, stories: 3 };

  it("says nothing while the scope and the size hold", () => {
    expect(outgrown(TOOL, SMALL)).toEqual([]);
    expect(
      outgrown(TOOL, { requirements: MAX_SPEC_REQUIREMENTS, stories: MAX_SPEC_STORIES }),
    ).toEqual([]);
  });

  it("says why when a threshold of the scope is crossed", () => {
    expect(outgrown(with_({ users: 500 }), SMALL)).toEqual(["users:crowd"]);
    expect(outgrown(with_({ sensitive: ["payment"] }), SMALL)).toEqual(["sensitive:payment"]);
    expect(outgrown({ ...TOOL, asked: "full" }, SMALL)).toEqual(["asked:full"]);
  });

  it("says why when the spec itself grew past a short document", () => {
    expect(outgrown(TOOL, { requirements: MAX_SPEC_REQUIREMENTS + 1, stories: 2 })).toEqual([
      `requirements:${MAX_SPEC_REQUIREMENTS + 1}`,
    ]);
    expect(outgrown(TOOL, { requirements: 4, stories: MAX_SPEC_STORIES + 1 })).toEqual([
      `stories:${MAX_SPEC_STORIES + 1}`,
    ]);
  });

  it("leaves a risky product the creator explicitly kept on the short path in peace, until it grows", () => {
    const kept = with_({ sensitive: ["accounts"], asked: "short" });
    expect(outgrown(kept, SMALL)).toEqual([]);
    expect(outgrown(kept, { requirements: 40, stories: 2 })).toEqual(["requirements:40"]);
  });
});

describe("reading the scope", () => {
  const RAW = { size: "small", users: 3, sensitive: [], integrations: 0, platforms: 1 };

  it("reads a header as the YAML gives it, and the words of the command line", () => {
    expect(readScope(RAW)).toEqual({ ok: true, criteria: { ...TOOL, users: 3 } });
    const words = scopeWords(["size=medium", "users=12", "sensitive=accounts,payment"]);
    expect(words).toEqual({ size: "medium", users: "12", sensitive: "accounts,payment" });
    expect(readScope({ ...words, integrations: "2", platforms: "1", asked: "short" })).toEqual({
      ok: true,
      criteria: {
        size: "medium",
        users: 12,
        sensitive: ["accounts", "payment"],
        integrations: 2,
        platforms: 1,
        asked: "short",
      },
    });
  });

  it("takes `none` and an empty list as no risk, and a repeated kind once", () => {
    expect(readScope({ ...RAW, sensitive: "none" })).toMatchObject({
      ok: true,
      criteria: { sensitive: [] },
    });
    expect(readScope({ ...RAW, sensitive: ["payment", "payment"] })).toMatchObject({
      criteria: { sensitive: ["payment"] },
    });
  });

  it.each([
    ["size", { size: "huge" }],
    ["users", { users: -1 }],
    ["users", { users: "many" }],
    ["users", { users: 1.5 }],
    ["sensitive", { sensitive: ["health"] }],
    ["sensitive", { sensitive: undefined }],
    ["integrations", { integrations: undefined }],
    ["platforms", { platforms: "" }],
    ["asked", { asked: "maybe" }],
  ])("refuses an unreadable %s", (reason, change) => {
    expect(readScope({ ...RAW, ...change })).toEqual({ ok: false, reason });
  });

  it("refuses a word that is not a key=value pair", () => {
    expect(scopeWords(["size"])).toBe(false);
    expect(scopeWords(["=small"])).toBe(false);
    expect(scopeWords(["size="])).toBe(false);
  });
});
