import { describe, expect, it } from "vitest";
import { gitBlobId, utf8 } from "./index.js";

describe("gitBlobId", () => {
  it("gives the id `git hash-object` gives, in SHA-1 and SHA-256 repositories", () => {
    expect(gitBlobId(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitBlobId(utf8("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(gitBlobId(new Uint8Array(), "sha256")).toBe(
      "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813",
    );
  });
});
