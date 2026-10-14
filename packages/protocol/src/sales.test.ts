import { describe, expect, it } from "vitest";
import { ErrorCode } from "./error-payload.js";
import { LAUNCH_DOCUMENT_REASONS } from "./launch.js";
import {
  OFFER_ID_PREFIX,
  OFFER_PRICING_STATUSES,
  OFFER_SECTIONS,
  SALES_FIELD,
  SEQUENCE_EMAIL_TITLE,
  SEQUENCE_ID_PREFIX,
  SEQUENCE_LONG_WARNING,
  SEQUENCE_SECTIONS,
  SEQUENCE_TYPES,
} from "./sales.js";

describe("the sales documents", () => {
  it("reuses the launch error code and adds its reasons to the list", () => {
    expect(ErrorCode.LAUNCH_DOCUMENT_INVALID).toBe("LAUNCH_DOCUMENT_INVALID");
    expect(new Set(LAUNCH_DOCUMENT_REASONS).size).toBe(LAUNCH_DOCUMENT_REASONS.length);
    expect(LAUNCH_DOCUMENT_REASONS.slice(-61, -49)).toEqual([
      "sales_missing",
      "sales_field",
      "sales_id",
      "sales_kind",
      "sales_owner",
      "sales_positioning_link",
      "sales_positioning_blob",
      "sales_pricing",
      "sales_section",
      "sales_evidence",
      "sales_emails",
      "sales_email_section",
    ]);
  });

  it("names the header block, the ids, the prices and the sequence types", () => {
    expect([SALES_FIELD, OFFER_ID_PREFIX, SEQUENCE_ID_PREFIX]).toEqual([
      "sales",
      "offer-",
      "sequence-",
    ]);
    // A price is free, stated by the creator, or absent: there is no fourth way.
    expect(OFFER_PRICING_STATUSES).toEqual(["free", "stated", "none"]);
    expect(SEQUENCE_TYPES).toEqual(["prospecting", "follow_up"]);
    expect(SEQUENCE_LONG_WARNING).toBe(7);
  });

  it("accepts the section titles in both languages, without case", () => {
    for (const titles of [...Object.values(OFFER_SECTIONS), ...Object.values(SEQUENCE_SECTIONS)]) {
      for (const title of titles) expect(title).toBe(title.toLowerCase());
      expect(titles.length).toBeGreaterThanOrEqual(2);
    }
    expect(SEQUENCE_EMAIL_TITLE.exec("email 3")?.[1]).toBe("3");
    expect(SEQUENCE_EMAIL_TITLE.exec("courriel 12")?.[1]).toBe("12");
    expect(SEQUENCE_EMAIL_TITLE.test("email")).toBe(false);
    expect(SEQUENCE_EMAIL_TITLE.test("before you send")).toBe(false);
  });
});
