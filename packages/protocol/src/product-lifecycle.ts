import { z } from "zod";
import { ProductAutonomySchema } from "./autonomy.js";
import { UlidSchema } from "./event-envelope.js";
import { PROFILE_PRESET_IDS, ProfileSchema, SemverSchema } from "./method-config.js";
import { readTolerant } from "./tolerant-reader.js";

/**
 * The life of a product, as the creator drives it from a device: creating one on a machine, saying
 * where it stands (stage), pausing it, archiving it, and changing its profile. Orders are signed
 * and strict; what a machine says back (its report) is read tolerantly by the devices.
 *
 * Nothing here deletes a file of the creator: archiving and pausing are marks the machine keeps,
 * and both are undone by the same gesture the other way round.
 */

/**
 * Where a product stands, as the creator sets it. A product the creator never placed shows the
 * stage its journal suggests (framing until a story started, development after).
 */
export const PRODUCT_STAGES = ["framing", "development", "launch", "online"] as const;
export type ProductStage = (typeof PRODUCT_STAGES)[number];
export const ProductStageSchema = z.enum(PRODUCT_STAGES);

/** The stage a starting profile proposes (the creator may change it while creating). */
export const PRESET_STAGE: Readonly<Record<(typeof PROFILE_PRESET_IDS)[number], ProductStage>> = {
  "new-product": "framing",
  maintenance: "online",
  "launch-only": "launch",
  prototype: "framing",
};

/** How a product starts: from an idea (no repository), from a repository already on the machine, or from an empty repository. */
export const PRODUCT_STARTS = ["idea", "existing", "empty"] as const;
export type ProductStart = (typeof PRODUCT_STARTS)[number];

/** What a machine says of the repository of a product: none, one it made empty, or one that was already there. */
export const PRODUCT_REPOSITORIES = ["none", "empty", "existing"] as const;
export type ProductRepository = (typeof PRODUCT_REPOSITORIES)[number];

export const PRODUCT_NAME_MAX = 80;
export const PRODUCT_IDEA_MAX = 4000;
export const PRODUCT_FOLDER_MAX = 100;
/** The most folders a machine lists under one location, and the most locations and creations it reports. */
export const PRODUCT_FOLDERS_LISTED_MAX = 50;
export const PRODUCT_LOCATIONS_MAX = 8;
export const PRODUCT_CREATIONS_MAX = 8;
/** The deepest a creator goes into a place when choosing where a product is made, and the most sub-folders one listing carries. */
export const PRODUCT_PATH_DEPTH_MAX = 12;
export const PRODUCT_BROWSE_LISTED_MAX = 200;
/** The longest folder path a machine tells of a product (the full path on the machine). */
export const PRODUCT_FOLDER_PATH_MAX = 1000;

/** The identifier of a place a machine allows products in (`home`, `place-2`): the machine names it, the device only repeats it. */
export const PRODUCT_LOCATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

const hasControl = (value: string): boolean =>
  [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/** A name the creator gives a product: trimmed, one line, no control character. */
export function isProductName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= PRODUCT_NAME_MAX &&
    value === value.trim() &&
    !hasControl(value)
  );
}

/**
 * A folder name inside a place the machine allows: one segment, never a path. It holds no
 * separator, no drive or stream mark, no control character, is not `.` or `..`, and does not end
 * with a dot or a space (which a system may drop silently).
 */
export function isFolderName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= PRODUCT_FOLDER_MAX &&
    value !== "." &&
    value !== ".." &&
    !/[\\/:*?"<>|]/.test(value) &&
    !hasControl(value) &&
    !/[. ]$/.test(value)
  );
}

/**
 * A step of the way into a place: one folder name, never a path, and never a hidden one (a name
 * that starts with a dot). The machine resolves the steps itself and refuses what leaves the place.
 */
export function isBrowseStep(value: string): boolean {
  return isFolderName(value) && !value.startsWith(".");
}

export const ORDER_TYPE_CREATE_PRODUCT = "product.create";
export const ORDER_TYPE_OPEN_PRODUCT_FOLDER = "product.open_folder";
export const ORDER_TYPE_SET_PRODUCT_STATE = "product.set_state";
export const ORDER_TYPE_SET_PRODUCT_PROFILE = "product.set_profile";
export const ORDER_TYPE_UPDATE_PRODUCT_ENGINE = "product.update_engine";

/**
 * The creator creates a product on this machine. The place is one the machine listed in its report
 * (`location`), never a path; a folder name is only given to take a repository already there
 * (`existing`). The idea, when there is one, is sealed content: the machine keeps it in the new
 * product, and the signed order the journal keeps holds a digest of it, not the text.
 */
export const CreateProductParamsSchema = z
  .strictObject({
    name: z.string().refine(isProductName, { message: "a name of one line, trimmed" }),
    start: z.enum(PRODUCT_STARTS),
    location: z.string().regex(PRODUCT_LOCATION_ID_PATTERN),
    folder: z.string().refine(isFolderName, { message: "a folder name, not a path" }).optional(),
    /** The folders to go through inside the place, one name each (as the machine listed them), to make the product there. */
    path: z
      .array(z.string().refine(isBrowseStep, { message: "a folder name, not a path" }))
      .max(PRODUCT_PATH_DEPTH_MAX)
      .optional(),
    preset: z.enum(PROFILE_PRESET_IDS),
    stage: ProductStageSchema,
    idea: z.string().min(1).max(PRODUCT_IDEA_MAX).optional(),
  })
  .superRefine((params, context) => {
    if (params.start === "existing" && params.folder === undefined) {
      context.addIssue({ code: "custom", path: ["folder"], message: "a repository to take" });
    }
    if (params.start === "existing" && params.path !== undefined) {
      context.addIssue({ code: "custom", path: ["path"], message: "not for an existing one" });
    }
    if (params.start !== "existing" && params.folder !== undefined) {
      context.addIssue({ code: "custom", path: ["folder"], message: "only for an existing one" });
    }
    if (params.start !== "idea" && params.idea !== undefined) {
      context.addIssue({ code: "custom", path: ["idea"], message: "only with an idea" });
    }
  });
export type CreateProductParams = z.infer<typeof CreateProductParamsSchema>;

/** Opens the product's folder in the machine's file explorer. Nothing is given: the machine knows the folder. */
export const OpenProductFolderParamsSchema = z.strictObject({});
export type OpenProductFolderParams = z.infer<typeof OpenProductFolderParamsSchema>;

/** The marks of a product the machine keeps. At least one is given; a mark not given is left as it is. */
export const SetProductStateParamsSchema = z
  .strictObject({
    stage: ProductStageSchema.optional(),
    paused: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((params) => Object.keys(params).length > 0, { message: "at least one mark" });
export type SetProductStateParams = z.infer<typeof SetProductStateParamsSchema>;

/** The profile of a product, whole: the engine checks it as it checks the terminal's. */
export const SetProductProfileParamsSchema = z.strictObject({ profile: ProfileSchema });
export type SetProductProfileParams = z.infer<typeof SetProductProfileParamsSchema>;

/**
 * Brings a product to the engine this machine runs (what `agentplugged init --upgrade-engine` then
 * `sync` do in a terminal). `to` is the version the creator read back before saying yes: the machine
 * refuses when it would not move the product to that version. Absent: whatever the machine runs.
 */
export const UpdateProductEngineParamsSchema = z.strictObject({ to: SemverSchema.optional() });
export type UpdateProductEngineParams = z.infer<typeof UpdateProductEngineParamsSchema>;

/**
 * What the main machine publishes of the engine a product runs (the `engine` key of
 * `projection.state` of the published state): the version the product is pinned to, the version the
 * machine can bring it to, and where an update asked from a device stands. The state's `state`
 * record is open, so a view that does not know this key still reads the rest.
 */
export const PublishedEngineSchema = z.strictObject({
  version: SemverSchema,
  /** The version this machine would bring the product to; absent when it cannot update products. */
  target: SemverSchema.optional(),
  /** `running` while an update asked from a device is under way; `failed` when the last one did not end. */
  update: z.enum(["running", "failed"]).optional(),
});
export type PublishedEngine = z.infer<typeof PublishedEngineSchema>;
/** What a view reads of it: unknown optional fields dropped, known ones as strict as above. */
export const PublishedEngineReader = readTolerant(PublishedEngineSchema);

/** The codes a refused order of this family answers with. */
export const PRODUCT_ORDER_CODES = {
  /** The place is not one of those this machine allows. */
  locationUnknown: "PRODUCT_LOCATION_UNKNOWN",
  /** The folder to take is not there, or not a folder of that place. */
  folderUnknown: "PRODUCT_FOLDER_UNKNOWN",
  /** The folder to take holds no repository. */
  notARepository: "PRODUCT_NOT_A_REPOSITORY",
  /** The folder already is an AgentPlugged product: it is linked with `pair`. */
  alreadyAProduct: "PRODUCT_ALREADY_A_PRODUCT",
  /** A creation is under way on this machine: one at a time. */
  busy: "PRODUCT_BUSY",
  /** This machine cannot run the engine (no program to run). */
  engineUnavailable: "PRODUCT_ENGINE_UNAVAILABLE",
  /** The machine does not serve this product. */
  notServed: "PRODUCT_NOT_SERVED",
  /** The profile could not be written (the engine refused it, or the file). */
  profileRefused: "PRODUCT_PROFILE_REFUSED",
  /** The marks could not be kept. */
  notSaved: "PRODUCT_NOT_SAVED",
  /** The folder of the product could not be opened on the machine (gone, or no explorer to open it). */
  openFailed: "PRODUCT_OPEN_FAILED",
  /** Agents work on the product, or an update of it is already under way: it is not touched meanwhile. */
  updateBusy: "PRODUCT_UPDATE_BUSY",
  /** The product already runs the engine this machine runs (or a newer one). */
  alreadyCurrent: "PRODUCT_ALREADY_CURRENT",
  /** The machine would not bring the product to the version the creator read back. */
  updateMismatch: "PRODUCT_UPDATE_MISMATCH",
} as const;
export type ProductOrderCode = (typeof PRODUCT_ORDER_CODES)[keyof typeof PRODUCT_ORDER_CODES];

/** The reference a creation answers with: the ticket the machine reports its progress under. */
export function creationReference(ticket: string): string {
  return `creation:${ticket}`;
}

/** The ticket a reference names, or undefined for any other text. */
export function creationOfReference(reference: string): string | undefined {
  const match = /^creation:([0-9A-HJKMNP-TV-Z]{26})$/.exec(reference);
  return match?.[1];
}

/** What a machine says of the place it allows products in. */
export const ProductLocationSchema = z.strictObject({
  id: z.string().regex(PRODUCT_LOCATION_ID_PATTERN),
  /** The folder as the creator reads it (the home folder written `~`). */
  label: z.string().min(1).max(200),
  /** The folders of this place that hold a repository and no product yet: ones to start from. */
  folders: z.array(z.string().refine(isFolderName)).max(PRODUCT_FOLDERS_LISTED_MAX),
  /** True for the place the creator chose the last time (the one to propose first). */
  last: z.literal(true).optional(),
});
export type ProductLocation = z.infer<typeof ProductLocationSchema>;

/** Why a creation did not end well: the folder, the repository, the engine's `init`, or the link to the creator's devices. */
export const PRODUCT_CREATION_FAILURES = ["folder", "repository", "engine", "link"] as const;
export type ProductCreationFailure = (typeof PRODUCT_CREATION_FAILURES)[number];

/**
 * A creation the machine is making, has made or could not make. It is told by its ticket (the
 * reference the order answered with); a finished one names the product it made. A finished or
 * failed one stays a few minutes in the report, so that a device that was away still learns it.
 */
export const ProductCreationSchema = z.strictObject({
  id: UlidSchema,
  name: z.string().min(1).max(PRODUCT_NAME_MAX),
  state: z.enum(["running", "done", "failed"]),
  /** The product made, once `done`. */
  product: UlidSchema.optional(),
  /** Why it failed. */
  code: z.enum(PRODUCT_CREATION_FAILURES).optional(),
});
export type ProductCreation = z.infer<typeof ProductCreationSchema>;

/** The marks and the profile a machine reports for a product it serves. */
export const ProductLifeSchema = z.strictObject({
  stage: ProductStageSchema.optional(),
  paused: z.literal(true).optional(),
  archived: z.literal(true).optional(),
  repository: z.enum(PRODUCT_REPOSITORIES).optional(),
  /** The full path of the product's folder on this machine: told to the creator's own devices only, never published. */
  folder: z.string().min(1).max(PRODUCT_FOLDER_PATH_MAX).optional(),
  profile: ProfileSchema.optional(),
  autonomy: ProductAutonomySchema.optional(),
});
export type ProductLife = z.infer<typeof ProductLifeSchema>;
