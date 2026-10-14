import { describe, expect, it } from "vitest";
import {
  CheckpointOpenedPayloadSchema,
  countWords,
  hasHiddenCharacter,
  hasMisleadingControl,
  OpenCheckpointInputSchema,
  PublicationInputSchema,
  readingSeconds,
  SHORT_VERSION_MAX_CHARS,
  SHORT_VERSION_MAX_WORDS,
} from "./index.js";

const BLOB = "a".repeat(40);
const PRESENTATION = {
  angle: "Your evenings back",
  audience: "Solo creators",
  short_version: "A team builds it. You validate.",
};
const PUBLICATION = {
  agent: "julien",
  type: "publication",
  risk: "medium",
  title: "Home page",
  summary: "The text of the home page.",
  documents: [{ path: ".agentplugged/docs/launch/pages/home.md", branch: "main", blob_sha: BLOB }],
  publication: PRESENTATION,
};

describe("reading a short version", () => {
  it("counts words in every script", () => {
    expect(countWords("One two three")).toBe(3);
    expect(countWords("Un, deux… trois !")).toBe(3);
    expect(countWords("")).toBe(0);
    expect(countWords("私は毎晩プログラムを書いています")).toBeGreaterThan(3);
  });

  it("reads 4 words a second: 15 seconds is 60 words, the limit 80", () => {
    expect(readingSeconds(Array.from({ length: 60 }, () => "word").join(" "))).toBe(15);
    expect(SHORT_VERSION_MAX_WORDS / 4).toBe(20);
  });

  it("finds hidden characters", () => {
    expect(hasHiddenCharacter("plain text", false)).toBe(false);
    expect(hasHiddenCharacter("two\nlines", false)).toBe(true);
    expect(hasHiddenCharacter("two\nlines", true)).toBe(false);
    for (const hidden of ["‮", "​", " ", " ", "\u0007", "\u001b[31m", "⁦"]) {
      expect(hasHiddenCharacter(`a${hidden}b`, true), JSON.stringify(hidden)).toBe(true);
    }
  });
});

describe("the presentation of a deliverable", () => {
  it("takes an angle, an audience and a short version, nothing more", () => {
    expect(PublicationInputSchema.safeParse(PRESENTATION).success).toBe(true);
    expect(PublicationInputSchema.safeParse({ ...PRESENTATION, extra: 1 }).success).toBe(false);
    for (const field of ["angle", "audience", "short_version"]) {
      const { [field]: _removed, ...rest } = PRESENTATION as Record<string, string>;
      expect(PublicationInputSchema.safeParse(rest).success, field).toBe(false);
    }
  });

  it("limits the short version in words and characters", () => {
    const words = (count: number) => Array.from({ length: count }, () => "word").join(" ");
    expect(
      PublicationInputSchema.safeParse({ ...PRESENTATION, short_version: words(80) }).success,
    ).toBe(true);
    expect(
      PublicationInputSchema.safeParse({ ...PRESENTATION, short_version: words(81) }).success,
    ).toBe(false);
    const chars = "x".repeat(SHORT_VERSION_MAX_CHARS + 1);
    expect(
      PublicationInputSchema.safeParse({ ...PRESENTATION, short_version: chars }).success,
    ).toBe(false);
  });

  it("keeps the angle and the audience on one line of visible characters", () => {
    for (const field of ["angle", "audience"] as const) {
      expect(PublicationInputSchema.safeParse({ ...PRESENTATION, [field]: "a\nb" }).success).toBe(
        false,
      );
      expect(PublicationInputSchema.safeParse({ ...PRESENTATION, [field]: "a‮b" }).success).toBe(
        false,
      );
      expect(
        PublicationInputSchema.safeParse({ ...PRESENTATION, [field]: "x".repeat(301) }).success,
      ).toBe(false);
      expect(PublicationInputSchema.safeParse({ ...PRESENTATION, [field]: "   " }).success).toBe(
        false,
      );
    }
  });
});

describe("open_checkpoint: type publication", () => {
  it("needs its presentation and the file of its full text", () => {
    expect(OpenCheckpointInputSchema.safeParse(PUBLICATION).success).toBe(true);
    expect(
      OpenCheckpointInputSchema.safeParse({ ...PUBLICATION, publication: undefined }).success,
    ).toBe(false);
    expect(OpenCheckpointInputSchema.safeParse({ ...PUBLICATION, documents: [] }).success).toBe(
      false,
    );
    expect(
      OpenCheckpointInputSchema.safeParse({ ...PUBLICATION, documents: undefined }).success,
    ).toBe(false);
  });

  it("goes with its type only, and has no options nor criteria", () => {
    expect(OpenCheckpointInputSchema.safeParse({ ...PUBLICATION, type: "document" }).success).toBe(
      false,
    );
    const options = [
      { id: "a", label: "A", consequence: "a" },
      { id: "b", label: "B", consequence: "b" },
    ];
    expect(
      OpenCheckpointInputSchema.safeParse({ ...PUBLICATION, options, recommendation: "a" }).success,
    ).toBe(false);
  });

  it("can supersede a deliverable sent back", () => {
    expect(
      OpenCheckpointInputSchema.safeParse({ ...PUBLICATION, supersedes: "G-7M2K9QX4TB" }).success,
    ).toBe(true);
  });

  it("still reads a payload opened before the presentation existed", () => {
    const payload = {
      type: "publication",
      risk: "medium",
      irreversible: false,
      recipient_role: "product",
      confirmation: ["gesture_undo_10s"],
      title: "Old page",
      summary: "Opened before the presentation existed.",
      documents: [],
      blocks: [],
    };
    expect(CheckpointOpenedPayloadSchema.safeParse(payload).success).toBe(true);
    expect(
      CheckpointOpenedPayloadSchema.safeParse({ ...payload, publication: PRESENTATION }).success,
    ).toBe(true);
    expect(
      CheckpointOpenedPayloadSchema.safeParse({
        ...payload,
        type: "document",
        publication: PRESENTATION,
      }).success,
    ).toBe(false);
  });
});

describe("hidden characters, joiners and lines", () => {
  const accepts = (short_version: string) =>
    PublicationInputSchema.safeParse({ ...PRESENTATION, short_version }).success;

  it("refuses the invisible characters that smuggle text", () => {
    for (const hidden of [
      "\ufe0e",
      "\u{e0100}",
      "\u034f",
      "\u3164",
      "\uffa0",
      "\u2800",
      "\u00a0",
      "\u3000",
      "\u2003",
    ]) {
      expect(accepts(`a${hidden}b`), JSON.stringify(hidden)).toBe(false);
    }
  });

  it("keeps the joiners of real scripts and emoji between visible characters", () => {
    expect(accepts("می\u200cخواهم")).toBe(true);
    expect(accepts("👨\u200d👩\u200d👧 family")).toBe(true);
    expect(accepts("\u200d")).toBe(false);
    expect(accepts("a \u200d b")).toBe(false);
  });

  it("reads Windows line ends, caps the lines and the empty ones", () => {
    expect(accepts("Line one.\r\nLine two.")).toBe(true);
    expect(accepts(Array.from({ length: 13 }, () => "word").join("\n"))).toBe(false);
    expect(accepts("one\n\ntwo")).toBe(false);
    expect(accepts("🚀🚀🚀")).toBe(false);
    expect(accepts("a\ud800")).toBe(false);
    expect(
      PublicationInputSchema.parse({ ...PRESENTATION, short_version: "a\r\nb" }).short_version,
    ).toBe("a\nb");
  });

  it("flags only what misleads in a full text", () => {
    expect(hasMisleadingControl("plain\ttext\r\nwith lines")).toBe(false);
    expect(hasMisleadingControl("می\u200cخواهم")).toBe(false);
    for (const bad of ["\u001b[31m", "\u202e", "\u2066", "\u0000", "\u2028"]) {
      expect(hasMisleadingControl(`a${bad}b`), JSON.stringify(bad)).toBe(true);
    }
  });
});
