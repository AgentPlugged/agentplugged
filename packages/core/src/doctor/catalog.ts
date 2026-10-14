import {
  EnvironmentCheckIdSchema,
  ErrorCode,
  PrerequisiteCommandSchema,
  PrerequisiteVersionSchema,
  TOOL_IDS,
} from "@agentplugged/protocol";
import { z } from "zod";
import { AgentPluggedError, reasonDetails } from "../errors.js";
import { normalizeText } from "../init/generated.js";
import { parseYaml, type SafeParser } from "../method/definitions.js";
import type { MethodSource } from "../method/method-source.js";

/**
 * The catalogue of the checks: `doctor.yaml`, shipped with the method next to
 * `models.yaml`. Every check says what it looks for (a detector among a closed set), the sentence
 * for each outcome (English, and French when the method translates it) and its repair (commands as
 * arrays of arguments, per platform and package manager, or steps to follow). A check is added by
 * writing data here, never by changing the engine.
 */

/** The catalogue in the shipped method. */
export const DOCTOR_CATALOG_FILE = "doctor.yaml";

/** What a detector can find. `ok` is the only outcome that is not a problem. */
export const OUTCOMES = [
  "ok",
  /** Not installed / not set up. */
  "missing",
  /** Found, but older than required. */
  "old",
  /** Found only in an install folder: the engine uses it, the editor may not see it. */
  "off_path",
  /** Found, its version cannot be read. */
  "unreadable",
  /** A Git setting is empty. */
  "unset",
  /** The forge's tool is there but not connected. */
  "logged_out",
  /** The forge's tool is not there, so no connection can be checked. */
  "no_cli",
  /** A port is taken. */
  "busy",
  /** A port is refused by the system (reserved range, rights). */
  "refused",
  /** Not enough memory. */
  "low",
  /** The service answers no (keychain, Windows Hello). */
  "unavailable",
  /** Found in the system's own PATH, which a program opened earlier does not have yet. */
  "stale",
  /** A service is installed but does not answer (Docker's engine). */
  "stopped",
  /** A port inside a range the system keeps for itself. */
  "reserved",
  /** Something that often goes wrong is set up that way (line endings). */
  "risky",
  /** The rights are missing. */
  "denied",
  /** A path longer than the system comfortably takes. */
  "long",
  /** A proxy or a company registry stands between the machine and the network. */
  "proxy",
  /** The disk has too little room. */
  "full",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

const OutcomeSchema = z.enum(OUTCOMES);

const PLATFORMS = ["win32", "darwin", "linux"] as const;

/** A sentence in English, and in French when the method gives it. */
export const TextSchema = z.strictObject({
  en: z.string().min(1).max(600),
  fr: z.string().min(1).max(600).optional(),
});
export type Text = z.infer<typeof TextSchema>;

/** Steps in English, and in French when the method gives them. */
const StepsSchema = z.strictObject({
  en: z.array(z.string().min(1).max(400)).min(1).max(12),
  fr: z.array(z.string().min(1).max(400)).min(1).max(12).optional(),
});
export type Steps = z.infer<typeof StepsSchema>;

const DirectorySchema = z
  .strictObject({
    for: PrerequisiteCommandSchema.optional(),
    env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_()]*$/)
      .optional(),
    home: z.literal(true).optional(),
    /** From the root of the file system (`/opt/homebrew/bin`); not on Windows. */
    root: z.literal(true).optional(),
    path: z.array(z.string().min(1).max(100)).min(1).max(8),
  })
  .refine(
    (value) =>
      [value.env !== undefined, value.home !== undefined, value.root !== undefined].filter(Boolean)
        .length === 1,
    { message: "give env, home or root, one of them" },
  );

const GroupIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,23}$/);

const DetectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("node"), min: PrerequisiteVersionSchema }),
  z.strictObject({
    kind: z.literal("command"),
    names: z.array(PrerequisiteCommandSchema).min(1).max(6),
    min: PrerequisiteVersionSchema.optional(),
    /** False: only look for it, never start it (a name that comes from a failure's text). */
    version: z.literal(false).optional(),
    also_in: z.array(DirectorySchema).max(12).optional(),
  }),
  z.strictObject({
    kind: z.literal("forge-cli"),
    also_in: z.array(DirectorySchema).max(12).optional(),
  }),
  z.strictObject({
    kind: z.literal("forge-login"),
    also_in: z.array(DirectorySchema).max(12).optional(),
  }),
  z.strictObject({ kind: z.literal("git-repo") }),
  z.strictObject({
    kind: z.literal("git-config"),
    keys: z
      .array(z.string().regex(/^[a-z]+\.[a-z][a-z0-9.-]*$/))
      .min(1)
      .max(4),
  }),
  // `any`: at least one AI tool is on the machine.
  z.strictObject({ kind: z.literal("ai-tool"), tool: z.enum([...TOOL_IDS, "any"]) }),
  z.strictObject({ kind: z.literal("keychain") }),
  z.strictObject({ kind: z.literal("presence") }),
  z.strictObject({ kind: z.literal("port"), port: z.int().min(1).max(65_535) }),
  z.strictObject({ kind: z.literal("memory"), min_gb: z.number().positive().max(4096) }),
  // The traps of a machine.
  /** The system's own PATH holds folders this process' PATH does not (a program opened earlier). */
  z.strictObject({ kind: z.literal("path-stale") }),
  /** Docker's engine answers (skipped where Docker is not installed). */
  z.strictObject({
    kind: z.literal("docker-daemon"),
    also_in: z.array(DirectorySchema).max(12).optional(),
  }),
  /** The memory Docker's engine was given. */
  z.strictObject({
    kind: z.literal("docker-memory"),
    min_gb: z.number().positive().max(4096),
    also_in: z.array(DirectorySchema).max(12).optional(),
  }),
  /** Free room on the disk of the product's folder. */
  z.strictObject({ kind: z.literal("disk"), min_gb: z.number().positive().max(100_000) }),
  /** The length of the product's folder path (Windows). */
  z.strictObject({ kind: z.literal("path-length"), max: z.int().min(20).max(260) }),
  /** What Git does with line endings, and whether the repository fixes them. */
  z.strictObject({ kind: z.literal("line-endings") }),
  /** Whether the process has administrator rights. */
  z.strictObject({ kind: z.literal("administrator") }),
  /** Proxy variables, Git's proxy, the package registry. */
  z.strictObject({ kind: z.literal("proxy") }),
]);
export type Detect = z.infer<typeof DetectSchema>;
export type DirectorySpecData = z.infer<typeof DirectorySchema>;

/** A value the creator types before a repair runs (the identity Git signs with). */
const AskSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,15}$/),
  say: TextSchema,
  /** What Enter gives: a placeholder of the facts, or text. */
  default: z.string().max(100).optional(),
  /** `email` is checked as an address, `text` as one plain line. */
  type: z.enum(["text", "email"]).optional(),
});
export type Ask = z.infer<typeof AskSchema>;

const OptionSchema = z.strictObject({
  /** All that is given must hold: the platform, a package manager present, the forge. */
  when: z
    .strictObject({
      platform: z.enum(PLATFORMS).optional(),
      manager: PrerequisiteCommandSchema.optional(),
      forge: z.enum(["github", "gitlab"]).optional(),
    })
    .optional(),
  /** Commands, in order; each an array of arguments, never a shell line. */
  commands: z
    .array(z.array(z.string().min(1).max(300)).min(1).max(40))
    .min(1)
    .max(4),
  /** Needs the creator's terminal (the browser, a password): never run from the chat. */
  interactive: z.boolean().optional(),
  ask: z.array(AskSchema).max(3).optional(),
});
export type FixOption = z.infer<typeof OptionSchema>;

const FixSchema = z.strictObject({
  /** The outcomes this repair is for; absent: every problem of the check. */
  outcomes: z.array(OutcomeSchema).min(1).optional(),
  /** The answer Enter gives to « repair it? » (✗ points: yes; the others: no unless listed). */
  recommended: z.boolean().optional(),
  /** Local, reversible, nothing installed: `--yes` may run it. */
  unattended: z.boolean().optional(),
  options: z.array(OptionSchema).max(12).optional(),
  /** What to do by hand, in order, when no option fits or the repair is not run by the engine. */
  steps: StepsSchema.optional(),
  /**
   * What to say once a repair ran, even when the point reads the same again (a program put on the
   * PATH of the account is still not on the PATH of the windows already open).
   */
  done: TextSchema.optional(),
});
export type Fix = z.infer<typeof FixSchema>;

const LevelSchema = z.enum(["warn", "fail"]);

const SaySchema = z
  .partialRecord(OutcomeSchema, TextSchema)
  .refine((say) => say.ok !== undefined, { message: "a check needs a sentence for ok" });

const CheckShape = {
  level: LevelSchema,
  /**
   * False: left out of the usual report, read only when a failure points to it or when it is
   * asked for by its id (administrator rights, line endings, proxy: facts that are not a problem
   * until something fails).
   */
  routine: z.boolean().optional(),
  /**
   * True: what it finds is a lead, never the cause by itself (not being an administrator is the
   * usual state; little memory does not prove a program was killed for lack of it). A diagnosis
   * says « a lead », not « the cause », when this is all it has.
   */
  weak: z.boolean().optional(),
  /** Also in the usual report when the architecture's prerequisites name this tool (`docker`). */
  with_tool: PrerequisiteCommandSchema.optional(),
  /** Systems it applies to; absent: all. */
  platforms: z.array(z.enum(PLATFORMS)).min(1).optional(),
  say: SaySchema,
  /** The repairs, by outcome: the first whose `outcomes` hold the outcome (or lists none) is used. */
  fix: z.array(FixSchema).max(6).optional(),
};

/** What to recognise a failure by. Text is matched whole, case-insensitively; no pattern language. */
const SignatureSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
  /** Any of these: an error code of the engine, an exit code, a piece of the message. */
  when: z
    .strictObject({
      code: z
        .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/))
        .min(1)
        .max(12)
        .optional(),
      exit_code: z.array(z.int().min(1).max(255)).min(1).max(8).optional(),
      output: z.array(z.string().min(2).max(80)).min(1).max(30).optional(),
    })
    .refine(
      (when) =>
        when.code !== undefined || when.exit_code !== undefined || when.output !== undefined,
      {
        message: "give code, exit_code or output",
      },
    ),
  /** What the failure shows by itself (from what was given, not from the machine). */
  say: TextSchema,
  /** The checks to read on the machine (ids of the catalogue): what they find can be the cause. */
  read: z.array(EnvironmentCheckIdSchema).max(8),
  /** Checks read too, but only ever as leads: what they find proves nothing about this failure. */
  lead: z.array(EnvironmentCheckIdSchema).max(8).optional(),
  /** Names to take out of the message and look at: a program, a port. */
  extract: z
    .array(z.enum(["command", "port"]))
    .max(2)
    .optional(),
  /** What is only supposed, and said so; shown when the machine does not explain it. */
  assumed: TextSchema.optional(),
});
export type Signature = z.infer<typeof SignatureSchema>;

const CheckSchema = z.strictObject({
  id: EnvironmentCheckIdSchema,
  group: GroupIdSchema,
  detect: DetectSchema,
  ...CheckShape,
});
export type CatalogCheck = z.infer<typeof CheckSchema>;

/** What a prerequisite of the architecture is checked with: the catalogue gives the sentences. */
const TemplateSchema = z.strictObject(CheckShape);
export type CheckTemplate = z.infer<typeof TemplateSchema>;

export const DoctorCatalogSchema = z
  .strictObject({
    format: z.literal(1),
    groups: z
      .array(z.strictObject({ id: GroupIdSchema, title: TextSchema }))
      .min(1)
      .max(12),
    checks: z.array(CheckSchema).min(1).max(200),
    templates: z.strictObject({
      tool: TemplateSchema,
      port: TemplateSchema,
      memory: TemplateSchema,
      /** A program a failure names, looked for without accusing anyone. */
      seen_tool: TemplateSchema,
      /** A port a failure names. */
      seen_port: TemplateSchema,
    }),
    /** What a failure looks like, and what to read on the machine to explain it. */
    signatures: z.array(SignatureSchema).max(60),
    /** The sentences of a diagnosis that are not about one check. */
    diagnosis: z.strictObject({
      /** `{text}`: the first point the machine shows. */
      found: TextSchema,
      /** `{text}`: the first lead, which proves nothing by itself. */
      suspected: TextSchema,
      /** `{count}`: how many points were read. */
      not_found: TextSchema,
      /** Recognised, but nothing on this machine to read about it. */
      nothing: TextSchema,
      unknown: TextSchema,
      doctor: TextSchema,
    }),
  })
  .superRefine((catalog, context) => {
    const groups = new Set(catalog.groups.map((group) => group.id));
    const seen = new Set<string>();
    for (const [index, check] of catalog.checks.entries()) {
      if (seen.has(check.id)) {
        context.addIssue({
          code: "custom",
          path: ["checks", index, "id"],
          message: "duplicate id",
        });
      }
      seen.add(check.id);
      if (!groups.has(check.group)) {
        context.addIssue({
          code: "custom",
          path: ["checks", index, "group"],
          message: "unknown group",
        });
      }
    }
    const ids = new Set(catalog.checks.map((check) => check.id));
    const signatureIds = new Set<string>();
    for (const [index, signature] of catalog.signatures.entries()) {
      if (signatureIds.has(signature.id)) {
        context.addIssue({
          code: "custom",
          path: ["signatures", index, "id"],
          message: "duplicate id",
        });
      }
      signatureIds.add(signature.id);
      for (const read of [...signature.read, ...(signature.lead ?? [])]) {
        if (!ids.has(read)) {
          context.addIssue({
            code: "custom",
            path: ["signatures", index, "read"],
            message: `unknown check ${read}`,
          });
        }
      }
    }
    if (!groups.has("prerequisites")) {
      context.addIssue({
        code: "custom",
        path: ["groups"],
        message: "the group prerequisites is required",
      });
    }
  });
export type DoctorCatalog = z.infer<typeof DoctorCatalogSchema>;

function catalogInvalid(path: string, field: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.METHOD_CONFIG_INVALID, "error.method_config_invalid", {
    path,
    field,
    ...reasonDetails(reason),
  });
}

/** Parses and validates a catalogue; the error names the file and the field. */
export function parseDoctorCatalog(path: string, text: string): DoctorCatalog | AgentPluggedError {
  return parseYaml(
    path,
    normalizeText(text),
    DoctorCatalogSchema as SafeParser<DoctorCatalog>,
    catalogInvalid,
  );
}

/** The catalogue of the shipped method. */
export async function readDoctorCatalog(
  method: MethodSource,
): Promise<DoctorCatalog | AgentPluggedError> {
  let text: string;
  try {
    text = await method.readText(DOCTOR_CATALOG_FILE);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return catalogInvalid(DOCTOR_CATALOG_FILE, "(root)", reason);
  }
  return parseDoctorCatalog(DOCTOR_CATALOG_FILE, text);
}
