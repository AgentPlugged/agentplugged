import { describe, expect, it } from "vitest";
import { ErrorCode, ErrorPayloadSchema } from "./error-payload.js";
import {
  CAMPAIGN_SECTIONS,
  CONTENT_ID_PREFIXES,
  CONTENT_SECTIONS,
  CONTENT_TYPES,
  KEYWORD_PROVENANCES,
  LAUNCH_DOCUMENT_REASONS,
  POSITIONING_DOCUMENT_ID,
  POSITIONING_SECTIONS,
  REFERENCE_PROVENANCES,
  SEO_DESCRIPTION_MAX,
  SEO_TITLE_MAX,
} from "./launch.js";

describe("the launch documents", () => {
  it("adds its error code last, with a valid payload", () => {
    expect(Object.values(ErrorCode)).toContain("LAUNCH_DOCUMENT_INVALID");
    const payload = {
      code: ErrorCode.LAUNCH_DOCUMENT_INVALID,
      message_key: "error.launch_document_invalid.keyword_unverified",
      details: { path: "p", line: 1, reason: "keyword_unverified" },
    };
    expect(ErrorPayloadSchema.parse(payload).code).toBe("LAUNCH_DOCUMENT_INVALID");
  });

  it("names each reason once, and the positioning's five sections in both languages", () => {
    expect(new Set(LAUNCH_DOCUMENT_REASONS).size).toBe(LAUNCH_DOCUMENT_REASONS.length);
    expect(Object.keys(POSITIONING_SECTIONS)).toEqual([
      "audience",
      "problem",
      "promise",
      "difference",
      "evidence",
    ]);
    for (const titles of Object.values(POSITIONING_SECTIONS)) {
      for (const title of titles) expect(title).toBe(title.toLowerCase());
      expect(titles.length).toBeGreaterThanOrEqual(2);
    }
    expect(POSITIONING_DOCUMENT_ID).toBe("positioning");
  });

  it("keeps the provenances of a measured keyword and the limits the engines show", () => {
    expect(KEYWORD_PROVENANCES).toEqual(["untrusted", "creator"]);
    expect([SEO_TITLE_MAX, SEO_DESCRIPTION_MAX]).toEqual([70, 170]);
  });

  it("appends the reasons of the contents after those", () => {
    expect(LAUNCH_DOCUMENT_REASONS.indexOf("keyword_proof")).toBeLessThan(
      LAUNCH_DOCUMENT_REASONS.indexOf("content_id"),
    );
    expect(LAUNCH_DOCUMENT_REASONS.at(-38)).toBe("content_key");
  });

  it("names the contents, their folders, their sections and the provenance of a citation", () => {
    expect(CONTENT_TYPES).toEqual({
      article: "content",
      community_post: "content",
      campaign_plan: "campaigns",
    });
    expect(CONTENT_ID_PREFIXES).toEqual({ content: "content-", campaigns: "campaign-" });
    expect(REFERENCE_PROVENANCES).toEqual(["untrusted", "creator", "knowledge_base"]);
    expect(Object.keys(CONTENT_SECTIONS)).toEqual(["text", "sources"]);
    expect(Object.keys(CAMPAIGN_SECTIONS)).toEqual([
      "objective",
      "audience",
      "channels",
      "calendar",
      "budget",
      "measurement",
      "actions",
      "sources",
    ]);
    for (const titles of [
      ...Object.values(CONTENT_SECTIONS),
      ...Object.values(CAMPAIGN_SECTIONS),
    ]) {
      for (const title of titles) expect(title).toBe(title.toLowerCase());
    }
  });
});
