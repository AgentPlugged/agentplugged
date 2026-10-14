import { describe, expect, it } from "vitest";
import { compareStoryIds, mergeOrder, mergeWaits, type ReadyStory } from "./merge-order.js";

const story = (id: string, opened: string, depends_on: string[] = []): ReadyStory => ({
  id,
  opened,
  depends_on,
});
const none = new Set<string>();

describe("The order of the merges", () => {
  it("compares story ids by their numbers", () => {
    expect(["4-10", "4-2", "10-1", "4-1"].sort(compareStoryIds)).toEqual([
      "4-1",
      "4-2",
      "4-10",
      "10-1",
    ]);
  });

  it("follows the dependency graph before everything else", () => {
    // 4-2 was opened first and is first in the sprint, but depends on 4-1.
    const order = mergeOrder({
      ready: [story("4-2", "01", ["4-1"]), story("4-1", "09")],
      done: none,
      sprint: ["4-2", "4-1"],
    });
    expect(order.map((entry) => [entry.story, entry.position])).toEqual([
      ["4-1", 1],
      ["4-2", 2],
    ]);
    expect(order[1]?.after).toEqual(["4-1"]);
  });

  it("then follows the sprint, the opening of the checkpoint and the number", () => {
    const order = mergeOrder({
      ready: [story("4-5", "01"), story("4-3", "05"), story("4-4", "03"), story("4-9", "02")],
      done: none,
      sprint: ["4-3"],
    });
    // 4-3 is in the sprint; the others by opening, then by number.
    expect(order.map((entry) => entry.story)).toEqual(["4-3", "4-5", "4-9", "4-4"]);
    const same = mergeOrder({
      ready: [story("4-10", "01"), story("4-2", "01")],
      done: none,
      sprint: [],
    });
    expect(same.map((entry) => entry.story)).toEqual(["4-2", "4-10"]);
  });

  it("is the same whatever the order the stories are given in", () => {
    const stories = [story("4-1", "03"), story("4-2", "02", ["4-1"]), story("4-3", "01")];
    const forward = mergeOrder({ ready: stories, done: none, sprint: [] });
    const backward = mergeOrder({ ready: [...stories].reverse(), done: none, sprint: [] });
    expect(forward).toEqual(backward);
  });

  it("ignores a dependency that is done and holds back one that is neither done nor ready", () => {
    const order = mergeOrder({
      ready: [story("4-3", "01", ["4-1", "4-2"])],
      done: new Set(["4-1"]),
      sprint: [],
    });
    expect(order[0]).toMatchObject({ position: 1, after: [], unmerged: ["4-2"], cycle: false });
  });

  it("gives no place to a dependency cycle nor to what depends on it", () => {
    const order = mergeOrder({
      ready: [
        story("4-1", "01", ["4-2"]),
        story("4-2", "02", ["4-1"]),
        story("4-3", "03", ["4-1"]),
        story("4-4", "04"),
      ],
      done: none,
      sprint: [],
    });
    expect(order.map((entry) => [entry.story, entry.position, entry.cycle])).toEqual([
      ["4-4", 1, false],
      ["4-1", 0, true],
      ["4-2", 0, true],
      ["4-3", 0, true],
    ]);
  });

  it("holds a story back behind its dependency and behind an earlier story sharing a file", () => {
    const order = mergeOrder({
      ready: [story("4-1", "01"), story("4-2", "02", ["4-1"]), story("4-3", "03")],
      done: none,
      sprint: [],
    });
    const files = new Map<string, ReadonlySet<string> | undefined>([
      ["4-1", new Set(["a.ts"])],
      ["4-2", new Set(["z.ts"])],
      ["4-3", new Set(["a.ts"])],
    ]);
    expect(mergeWaits(order, "4-1", files)).toEqual([]);
    expect(mergeWaits(order, "4-2", files)).toEqual([{ story: "4-1", why: "dependency" }]);
    expect(mergeWaits(order, "4-3", files)).toEqual([{ story: "4-1", why: "overlap" }]);
  });

  it("lets stories with disjoint files merge in any order", () => {
    const order = mergeOrder({
      ready: [story("4-1", "01"), story("4-3", "02")],
      done: none,
      sprint: [],
    });
    const files = new Map<string, ReadonlySet<string> | undefined>([
      ["4-1", new Set(["a.ts"])],
      ["4-3", new Set(["b.ts"])],
    ]);
    expect(mergeWaits(order, "4-3", files)).toEqual([]);
  });

  it("is careful when the files of a story are unknown", () => {
    const order = mergeOrder({
      ready: [story("4-1", "01"), story("4-3", "02")],
      done: none,
      sprint: [],
    });
    expect(
      mergeWaits(
        order,
        "4-3",
        new Map([
          ["4-1", new Set(["a.ts"])],
          ["4-3", undefined],
        ]),
      ),
    ).toEqual([{ story: "4-1", why: "overlap" }]);
    expect(
      mergeWaits(
        order,
        "4-3",
        new Map([
          ["4-1", undefined],
          ["4-3", new Set(["b.ts"])],
        ]),
      ),
    ).toEqual([{ story: "4-1", why: "overlap" }]);
  });

  it("gives no wait to a story outside the order or in a cycle", () => {
    const order = mergeOrder({
      ready: [story("4-1", "01", ["4-2"]), story("4-2", "02", ["4-1"])],
      done: none,
      sprint: [],
    });
    expect(mergeWaits(order, "4-1", new Map())).toEqual([]);
    expect(mergeWaits(order, "9-9", new Map())).toEqual([]);
  });
});
