import { describe, expect, it } from "vitest";
import { type CreatorReply, readReply, withNote } from "./decision-prompt.js";

const prompt = {
  choices: [
    { id: "approve", decision: "approved", recommended: false, needs_note: false },
    { id: "reject", decision: "rejected", recommended: false, needs_note: true },
    { id: "changes", decision: "changes_requested", recommended: false, needs_note: true },
  ],
} as never;

const accept = (content: Record<string, unknown>): CreatorReply => ({ action: "accept", content });

describe("one gesture per validation (corrections B)", () => {
  it("records an approval at once, with no note", () => {
    expect(readReply(prompt, accept({ choice: "approve" }))).toEqual({ decision: "approved" });
  });

  it("asks for the note, and records nothing, for a refusal or a request for changes", () => {
    expect(readReply(prompt, accept({ choice: "reject" }))).toBe("note_required");
    expect(readReply(prompt, accept({ choice: "changes" }))).toBe("note_required");
    expect(readReply(prompt, accept({ choice: "changes", note: "   " }))).toBe("note_required");
  });

  it("records the refusal once the second question gave its note", () => {
    const first = accept({ choice: "reject" }) as Extract<CreatorReply, { action: "accept" }>;
    const joined = withNote(first, accept({ note: "Trop cher." }));
    expect(readReply(prompt, joined)).toEqual({ decision: "rejected", note: "Trop cher." });
  });

  it("records nothing when the second question is declined, cancelled or fails", () => {
    const first = accept({ choice: "changes" }) as Extract<CreatorReply, { action: "accept" }>;
    expect(readReply(prompt, withNote(first, { action: "decline" }))).toBe("declined");
    expect(readReply(prompt, withNote(first, { action: "cancel" }))).toBe("cancelled");
    expect(readReply(prompt, withNote(first, { action: "failed" }))).toBe("failed");
    // An empty note is no answer either.
    expect(readReply(prompt, withNote(first, accept({ note: "" })))).toBe("note_required");
  });

  it("never reads a choice the form did not offer, nor the old neutral entry", () => {
    expect(readReply(prompt, accept({ choice: "none" }))).toBe("invalid");
    expect(readReply(prompt, accept({}))).toBe("invalid");
    expect(readReply(prompt, accept({ choice: "zzz" }))).toBe("invalid");
  });
});
