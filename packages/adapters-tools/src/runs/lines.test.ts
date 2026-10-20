import { describe, expect, it } from "vitest";
import { LineSplitter } from "./lines.js";

describe("LineSplitter", () => {
  it("cuts on line breaks, with or without a carriage return, and skips empty lines", () => {
    const splitter = new LineSplitter();
    expect(splitter.push("one\r\ntwo\n\nthree")).toEqual(["one", "two"]);
    expect(splitter.push("\nfour\n")).toEqual(["three", "four"]);
    expect(splitter.end()).toEqual([]);
  });

  it("keeps a multi-byte character split between two chunks whole", () => {
    const splitter = new LineSplitter();
    const bytes = Buffer.from('{"t":"é€"}\n', "utf8");
    const cut = bytes.indexOf(0xe2) + 1;
    expect(splitter.push(bytes.subarray(0, cut))).toEqual([]);
    expect(splitter.push(bytes.subarray(cut))).toEqual(['{"t":"é€"}']);
  });

  it("returns the last line when the stream ends without a line break", () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}')).toEqual([]);
    expect(splitter.end()).toEqual(['{"a":1}']);
  });

  it("drops a line that is too long, up to its end, and goes on with the next one", () => {
    const splitter = new LineSplitter(10);
    expect(splitter.push("x".repeat(8))).toEqual([]);
    expect(splitter.push("x".repeat(8))).toEqual([]);
    expect(splitter.push("xx\nok\n")).toEqual(["ok"]);
    expect(splitter.push(`${"y".repeat(30)}\nfine\n`)).toEqual(["fine"]);
    expect(splitter.dropped).toBe(2);
  });
});
