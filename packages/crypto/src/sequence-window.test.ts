import { describe, expect, it } from "vitest";
import { nextSequence, SEQUENCE_WINDOW_SIZE, SequenceWindow } from "./index.js";

describe("the sliding window of sequence numbers", () => {
  it("accepts new numbers, in order or not, and refuses a number seen", () => {
    const window = new SequenceWindow();
    expect(window.accept(1)).toBe("accepted");
    expect(window.accept(1)).toBe("duplicate");
    expect(window.accept(5)).toBe("accepted");
    expect(window.accept(3)).toBe("accepted"); // reordered inside the window
    expect(window.accept(3)).toBe("duplicate");
    expect(window.accept(5)).toBe("duplicate");
  });

  it("refuses what is 64 or more below the highest, accepts 63 below", () => {
    const window = new SequenceWindow();
    window.accept(100);
    expect(window.check(100 - SEQUENCE_WINDOW_SIZE)).toBe("too_old");
    expect(window.check(100 - SEQUENCE_WINDOW_SIZE + 1)).toBe("accepted");
    expect(window.accept(37)).toBe("accepted");
    expect(window.accept(36)).toBe("too_old");
    window.accept(200);
    expect(window.accept(100)).toBe("too_old");
    expect(window.state().seen).toEqual([200]);
  });

  it("refuses numbers that are not numbers of a message", () => {
    const window = new SequenceWindow();
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "1" as never]) {
      expect(window.accept(bad), String(bad)).toBe("invalid");
    }
    expect(window.state()).toEqual({ highest: 0, seen: [] });
  });

  it("check() does not move the window; accept() does", () => {
    const window = new SequenceWindow();
    expect(window.check(9)).toBe("accepted");
    expect(window.check(9)).toBe("accepted");
    window.accept(9);
    expect(window.check(9)).toBe("duplicate");
  });

  it("survives a restart through its plain JSON state, and refuses a state that is not valid", () => {
    const window = new SequenceWindow();
    for (const seq of [1, 2, 4, 70]) window.accept(seq);
    const stored = JSON.parse(JSON.stringify(window.state()));
    const restored = SequenceWindow.restore(stored);
    expect(restored?.state()).toEqual(window.state());
    expect(restored?.accept(70)).toBe("duplicate");
    expect(restored?.accept(4)).toBe("too_old");
    expect(restored?.accept(30)).toBe("accepted");
    for (const bad of [
      null,
      "x",
      {},
      { highest: -1, seen: [] },
      { highest: 3, seen: [5] },
      { highest: 3, seen: [2, 2, 3] },
      { highest: 3, seen: [3, 2] },
      { highest: 3, seen: [2] },
      { highest: 0, seen: [1] },
      { highest: 200, seen: [100, 200] },
      { highest: 70, seen: Array.from({ length: 65 }, (_, index) => index + 6) },
    ]) {
      expect(SequenceWindow.restore(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("numbers the messages of a sender from 1, never twice", () => {
    expect(nextSequence(0)).toBe(1);
    expect(nextSequence(41)).toBe(42);
    expect(() => nextSequence(-1)).toThrow(RangeError);
    expect(() => nextSequence(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    expect(() => nextSequence(1.5)).toThrow(RangeError);
  });
});
