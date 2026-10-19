import { describe, expect, it } from "vitest";
import {
  HISTORY_COLUMNS,
  HISTORY_CSV_COLUMNS,
  type HistoryEntry,
  historyCsv,
} from "./validation-history.js";

const ENTRY: HistoryEntry = {
  event: "01J9ZQ4V8E3M5N7P9R1S3T5V01",
  at: "2026-10-15T12:00:00.000Z",
  author: "machine:LAPTOPLAPTOPLAPT",
  author_trust: null,
  author_endorsed_at: null,
  source: "web",
  decision: "approved",
  option: null,
  waiver_until: null,
  assurance: "device",
  locale_on_high_risk: false,
  checkpoint: "G-ABCDEFGHIJ",
  checkpoint_type: "document",
  checkpoint_risk: "low",
  checkpoint_title: '=Titre, avec "guillemets"\net une ligne',
  story: null,
  checkpoint_phase: null,
  quote: null,
  relayed_by: null,
  channel: null,
  stack: null,
  via: null,
};

describe("the CSV of the validation history", () => {
  it("has one column per field of an entry, then the reason of an ignored answer", () => {
    expect([...HISTORY_COLUMNS].sort()).toEqual(Object.keys(ENTRY).sort());
    expect(HISTORY_CSV_COLUMNS.at(-1)).toBe("ignored_reason");
  });

  it("starts with the byte order mark and the header, ends each line with CRLF", () => {
    const csv = historyCsv([ENTRY]);
    expect(csv.startsWith(`﻿${HISTORY_CSV_COLUMNS.join(",")}\r\n`)).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("quotes what needs it and neutralises a formula", () => {
    const csv = historyCsv([ENTRY]);
    expect(csv).toContain(`"'=Titre, avec ""guillemets""\net une ligne"`);
  });

  it("writes an ignored answer with its reason and empty cells", () => {
    const csv = historyCsv(
      [],
      [
        {
          event: "01J9ZQ4V8E3M5N7P9R1S3T5V02",
          at: "2026-10-15T12:00:00.000Z",
          author: null,
          actor_kind: "agent",
          checkpoint: "G-ABCDEFGHIJ",
          decision: "approved",
          story: null,
          reason: "not_human",
        },
      ],
    );
    const line = csv.split("\r\n")[1] ?? "";
    expect(line.endsWith(",not_human")).toBe(true);
    expect(line.split(",")).toHaveLength(HISTORY_CSV_COLUMNS.length);
  });
});
