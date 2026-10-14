import { describe, expect, it } from "vitest";
import { jsonLines } from "./node-chat-store.js";

describe("the lines of the chat store", () => {
  it("keeps the objects, and leaves out a blank line, a cut line, null and what is not an object", () => {
    const text = ['{"v":1}', "", "null", "5", '"x"', '{"v":2', '{"v":3}', "[1]"].join("\n");
    expect(jsonLines(text)).toEqual([{ v: 1 }, { v: 3 }, [1]]);
  });
});
