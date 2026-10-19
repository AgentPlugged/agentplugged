import { describe, expect, it } from "vitest";
import { toBase64url, utf8 } from "./encoding.js";
import { contentDigest, PartAssembler, splitIntoParts } from "./feed-parts.js";

const ID = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
const OTHER = "01J9ZQ4V8E3M5N7P9R1S3T5V7Y";

function content(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) % 251;
  return bytes;
}

describe("parts of a message", () => {
  it("cut a content into parts of the size asked, and put it back whatever the order", () => {
    const whole = content(1000);
    const parts = splitIntoParts(whole, ID, 300);
    expect(parts).toHaveLength(4);
    expect(parts.every((part) => part.count === 4 && part.id === ID)).toBe(true);
    const assembler = new PartAssembler();
    const verdicts = [2, 0, 3, 1].map((i) => assembler.add(parts[i], 1));
    expect(verdicts.slice(0, 3).every((v) => v.status === "incomplete")).toBe(true);
    const last = verdicts[3];
    expect(last?.status).toBe("complete");
    if (last?.status === "complete") expect(last.content).toEqual(whole);
  });

  it("make one part of a small content", () => {
    expect(splitIntoParts(content(10), ID, 300)).toHaveLength(1);
  });

  it("reject a whole when one part was altered", () => {
    const parts = splitIntoParts(content(900), ID, 300);
    const altered = { ...parts[1], data: toBase64url(utf8("x".repeat(300))) };
    const assembler = new PartAssembler();
    assembler.add(parts[0], 1);
    assembler.add(altered, 1);
    const verdict = assembler.add(parts[2], 1);
    expect(verdict).toEqual({ status: "rejected", id: ID, reason: "digest_mismatch" });
  });

  it("wait for a part that is missing, and drop what waits too long", () => {
    const parts = splitIntoParts(content(900), ID, 300);
    const assembler = new PartAssembler();
    assembler.add(parts[0], 100);
    expect(assembler.add(parts[2], 100).status).toBe("incomplete");
    expect(assembler.waiting()).toEqual([{ id: ID, startedAt: 100 }]);
    expect(assembler.expire(50)).toBe(0);
    expect(assembler.expire(200)).toBe(1);
    expect(assembler.waiting()).toEqual([]);
  });

  it("reject parts that disagree on the count or the fingerprint", () => {
    const parts = splitIntoParts(content(900), ID, 300);
    const foreign = splitIntoParts(content(901), ID, 300);
    const assembler = new PartAssembler();
    assembler.add(parts[0], 1);
    expect(assembler.add(foreign[1], 1)).toEqual({
      status: "rejected",
      id: ID,
      reason: "inconsistent",
    });
  });

  it("ignore a part seen twice, and reject one that says something else the second time", () => {
    const parts = splitIntoParts(content(900), ID, 300);
    const assembler = new PartAssembler();
    assembler.add(parts[0], 1);
    expect(assembler.add(parts[0], 1)).toEqual({ status: "ignored" });
    const changed = { ...parts[0], data: toBase64url(utf8("y".repeat(300))) };
    expect(assembler.add(changed, 1).status).toBe("rejected");
  });

  it("reject what is not a part", () => {
    const assembler = new PartAssembler();
    expect(assembler.add({ id: "nope" }, 1).status).toBe("rejected");
    expect(assembler.add(null, 1).status).toBe("rejected");
    const part = splitIntoParts(content(10), ID, 300)[0];
    expect(assembler.add({ ...part, index: 5 }, 1).status).toBe("rejected");
  });

  it("keep several messages apart, and only so many at once", () => {
    const assembler = new PartAssembler({ maxGroups: 2 });
    const a = splitIntoParts(content(600), ID, 300);
    const b = splitIntoParts(content(700), OTHER, 300);
    assembler.add(a[0], 1);
    assembler.add(b[0], 2);
    const c = splitIntoParts(content(800), "01J9ZQ4V8E3M5N7P9R1S3T5V7Z", 300);
    assembler.add(c[0], 3);
    expect(assembler.waiting().map((w) => w.id)).toEqual([OTHER, "01J9ZQ4V8E3M5N7P9R1S3T5V7Z"]);
  });

  it("keeps the parts of two senders apart even when they use the same id", () => {
    const parts = splitIntoParts(content(900), ID, 300);
    const assembler = new PartAssembler();
    assembler.add(parts[0], 1, "a");
    assembler.add(parts[1], 1, "b");
    expect(assembler.add(parts[2], 1, "a").status).toBe("incomplete");
    expect(assembler.waiting()).toHaveLength(2);
  });

  it("refuse to build more than the limit", () => {
    const assembler = new PartAssembler({ maxBytes: 100 });
    const parts = splitIntoParts(content(600), ID, 300);
    assembler.add(parts[0], 1);
    expect(assembler.add(parts[1], 1).status).toBe("rejected");
  });

  it("have a digest that depends on every byte", () => {
    expect(contentDigest(content(10))).not.toBe(contentDigest(content(11)));
    expect(contentDigest(content(10))).toHaveLength(43);
  });

  it("do not cut nothing, nor into pieces of no size", () => {
    expect(() => splitIntoParts(new Uint8Array(), ID, 10)).toThrow(RangeError);
    expect(() => splitIntoParts(content(5), ID, 0)).toThrow(RangeError);
  });
});
