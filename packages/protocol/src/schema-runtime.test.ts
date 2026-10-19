import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { disableSchemaCodegen } from "./schema-runtime.js";

describe("disableSchemaCodegen", () => {
  it("keeps every result the same and never builds code from text", () => {
    const schema = z.object({ name: z.string().min(1), tags: z.array(z.string()).max(2) });
    const before = schema.safeParse({ name: "a", tags: ["x"] });
    const failing = schema.safeParse({ name: "", tags: ["x", "y", "z"] });

    const real = globalThis.Function;
    const calls = vi.fn();
    globalThis.Function = new Proxy(real, {
      apply(target, thisArg, args) {
        calls();
        return Reflect.apply(target, thisArg, args);
      },
      construct(target, args) {
        calls();
        return Reflect.construct(target, args);
      },
    });
    try {
      disableSchemaCodegen();
      const fresh = z.object({ id: z.string(), n: z.number().int() });
      expect(fresh.safeParse({ id: "1", n: 2 }).success).toBe(true);
      expect(fresh.safeParse({ id: "1", n: 2.5 }).success).toBe(false);
      expect(calls).not.toHaveBeenCalled();
    } finally {
      globalThis.Function = real;
    }

    expect(before.success).toBe(true);
    expect(failing.success).toBe(false);
    expect(schema.safeParse({ name: "a", tags: [] }).success).toBe(true);
  });
});
