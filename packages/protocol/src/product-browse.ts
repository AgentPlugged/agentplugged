import { z } from "zod";
import {
  isBrowseStep,
  PRODUCT_BROWSE_LISTED_MAX,
  PRODUCT_LOCATION_ID_PATTERN,
  PRODUCT_PATH_DEPTH_MAX,
} from "./product-lifecycle.js";

/**
 * Choosing where a product is made, by clicking: the shapes the request and the answer of the file
 * reading carry (`folders`). A device names a place the machine listed in its report and the steps
 * taken inside it, one folder name each, as the machine listed them; it never sends a path. The
 * machine resolves the steps itself, refuses whatever leaves the place (a link, a junction, a
 * separator, `..`), and lists only the folders a creator may put a product in: no hidden folder,
 * no folder of the system.
 */

/** The request shape (without the identifier, the version and the product, which the file reading adds). */
export const FoldersRequestFields = {
  op: z.literal("folders"),
  /** The identifier of a place the machine listed. */
  location: z.string().regex(PRODUCT_LOCATION_ID_PATTERN),
  /** The folders gone into, from the place. */
  path: z
    .array(z.string().refine(isBrowseStep, { message: "a folder name, not a path" }))
    .max(PRODUCT_PATH_DEPTH_MAX)
    .optional(),
} as const;

export const FoldersDataSchema = z.strictObject({
  op: z.literal("folders"),
  location: z.string().regex(PRODUCT_LOCATION_ID_PATTERN),
  /** The steps the answer is about (the request's). */
  path: z.array(z.string().refine(isBrowseStep)).max(PRODUCT_PATH_DEPTH_MAX),
  /** The folder as the creator reads it (the home folder written `~`). */
  label: z.string().min(1).max(1200),
  /** The folders inside it that can be gone into, by name. */
  folders: z.array(z.string().refine(isBrowseStep)).max(PRODUCT_BROWSE_LISTED_MAX),
  /** True when there are more folders than listed. */
  truncated: z.boolean(),
});
export type FoldersData = z.infer<typeof FoldersDataSchema>;
