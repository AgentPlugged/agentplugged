import type { ValidationAssurance, ValidationDecision, ValidationSource } from "./chat.js";
import type { CheckpointRisk, CheckpointType } from "./checkpoint.js";
import type { PhaseId } from "./method-config.js";
import type { IgnoredReason } from "./projection-state.js";

/**
 * The history of the creator's validations, as the terminal and the web view both write it:
 * one row per validation, the columns of the exports, and the CSV text. One definition, so that
 * the file `history --export` writes and the file the browser saves hold the same columns.
 */

/**
 * One validation of the history, with what the creator needs to read it: who (and how far their key
 * is trusted), when (ISO UTC), the decision and its option or waiver deadline, the assurance, and
 * the checkpoint answered. Its fields are the export's (in English).
 */
export interface HistoryEntry {
  /** The ULID of the event that answered. */
  readonly event: string;
  /** ISO 8601, UTC. */
  readonly at: string;
  /**
   * The device that signed: the creator's (`human:...`) at the terminal, the machine's for an
   * answer relayed from the chat, applied by the engine or carried from a browser.
   */
  readonly author: string;
  /** `root` (the product's first creator key) or `endorsed`; null when the key is not known. */
  readonly author_trust: "root" | "endorsed" | null;
  /** When the key was endorsed (ISO UTC), for an `endorsed` key whose endorsement is found. */
  readonly author_endorsed_at: string | null;
  /**
   * `terminal`, `chat` (« via le chat »), `auto` (« appliqué automatiquement »), `elicitation`
   * (« choisie dans l'outil »), `agent` or `web`.
   */
  readonly source: ValidationSource;
  readonly decision: ValidationDecision;
  readonly option: string | null;
  /** A waiver's deadline (ISO UTC), or null. */
  readonly waiver_until: string | null;
  readonly assurance: ValidationAssurance;
  /** A `high` risk checkpoint answered with the `locale` assurance only. */
  readonly locale_on_high_risk: boolean;
  readonly checkpoint: string;
  readonly checkpoint_type: CheckpointType | null;
  readonly checkpoint_risk: CheckpointRisk | null;
  readonly checkpoint_title: string | null;
  readonly story: string | null;
  /** The phase a `phase_end` checkpoint closes, else null. */
  readonly checkpoint_phase: PhaseId | null;
  /** The creator's words an agent relayed from the chat, else null. */
  readonly quote: string | null;
  /** The agent that relayed a chat answer (or asked the form's), else null. */
  readonly relayed_by: string | null;
  /** The AI tool whose form the creator answered in, else null. */
  readonly channel: string | null;
  /** The stack of points the creator answered together, else null. */
  readonly stack: string | null;
  /** `question_tool` when the creator chose in the AI tool's question tool, else null. */
  readonly via: string | null;
}

/** A `checkpoint.resolved` the projection ignored (`--all`), with its reason. */
export interface IgnoredValidation {
  readonly event: string;
  /** ISO 8601, UTC, or as written when it is not a date. */
  readonly at: string;
  /** Its `actor.device`, or null. */
  readonly author: string | null;
  /** Its `actor.kind` (`human`, `agent`, `system`…), or null. */
  readonly actor_kind: string | null;
  readonly checkpoint: string | null;
  readonly decision: string | null;
  readonly story: string | null;
  readonly reason: IgnoredReason;
}

/** The columns of the CSV export, in order: the fields of `HistoryEntry`. */
export const HISTORY_COLUMNS = [
  "at",
  "author",
  "author_trust",
  "author_endorsed_at",
  "source",
  "decision",
  "option",
  "waiver_until",
  "assurance",
  "locale_on_high_risk",
  "checkpoint",
  "checkpoint_type",
  "checkpoint_risk",
  "checkpoint_title",
  "story",
  "event",
  "checkpoint_phase",
  "quote",
  "relayed_by",
  "channel",
  "stack",
  "via",
] as const satisfies ReadonlyArray<keyof HistoryEntry>;

/** The CSV export's columns: those of `HistoryEntry`, then the reason of an ignored answer. */
export const HISTORY_CSV_COLUMNS = [...HISTORY_COLUMNS, "ignored_reason"] as const;

type CsvRow = {
  readonly [column in (typeof HISTORY_CSV_COLUMNS)[number]]: string | boolean | null;
};

/** The UTF-8 byte order mark: spreadsheets then read the accents right. */
const BOM = String.fromCharCode(0xfeff);

/** Starts a spreadsheet formula when a cell begins with it. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV field (RFC 4180): quoted when it holds a comma, a quote or a line break. A text a
 * spreadsheet would run as a formula (`=`, `+`, `-`, `@`, tab, CR first) is prefixed with `'`.
 */
function csvField(value: string | boolean | null): string {
  let text = value === null ? "" : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function ignoredRow(item: IgnoredValidation): CsvRow {
  return {
    at: item.at,
    author: item.author,
    author_trust: null,
    author_endorsed_at: null,
    source: null,
    decision: item.decision,
    option: null,
    waiver_until: null,
    assurance: null,
    locale_on_high_risk: null,
    checkpoint: item.checkpoint,
    checkpoint_type: null,
    checkpoint_risk: null,
    checkpoint_title: null,
    story: item.story,
    checkpoint_phase: null,
    quote: null,
    relayed_by: null,
    channel: null,
    stack: null,
    via: null,
    event: item.event,
    ignored_reason: item.reason,
  };
}

/**
 * The CSV export, for spreadsheets (RFC 4180, UTF-8 with a byte order mark so that accents read
 * right): a header of the English field names, then one record per entry, then (`--all`) one per
 * ignored answer with its `ignored_reason` (empty for the valid ones). Each line ends with CRLF; a
 * null is an empty field; formulas are neutralised (`csvField`), so the JSON export is the exact
 * one.
 */
export function historyCsv(
  entries: readonly HistoryEntry[],
  ignored: readonly IgnoredValidation[] | null = null,
): string {
  const rows: CsvRow[] = [
    ...entries.map((entry) => ({ ...entry, ignored_reason: null })),
    ...(ignored ?? []).map(ignoredRow),
  ];
  const lines = [HISTORY_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(HISTORY_CSV_COLUMNS.map((column) => csvField(row[column])).join(","));
  }
  return `${BOM}${lines.map((line) => `${line}\r\n`).join("")}`;
}
