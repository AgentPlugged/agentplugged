import type { OpenCheckpointInput } from "@agentplugged/protocol";

/**
 * Absolute paths that point inside the product, written as relative ones. An agent that cites a
 * file by its absolute path would show the creator's user name on every surface; the point keeps
 * the file's place in the product instead. A path outside the product, or one that climbs out of
 * it with `..`, is left as it is.
 */

const PATH_CHARS = "[^\\s\"'`<>()\\[\\]{},;|*?]";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The patterns of the product's folder, whatever the separator style: followed by a path inside
 * it, and standing alone (the folder itself).
 */
function rootPatterns(root: string): { inside: RegExp; alone: RegExp } | undefined {
  const cleaned = root.replace(/[\\/]+$/, "");
  if (cleaned === "" || !/^(?:[A-Za-z]:[\\/]|\/)/.test(cleaned)) return undefined;
  const parts = cleaned.split(/[\\/]+/).map(escapeRegex);
  const flags = /^[A-Za-z]:/.test(cleaned) ? "gi" : "g";
  const folder = `(?<![\\w.\\-])${parts.join("[\\\\/]+")}`;
  return {
    inside: new RegExp(`${folder}[\\\\/]+(${PATH_CHARS}+)`, flags),
    // Not followed by a name (a sibling folder), nor by a path (handled above, or one that climbs).
    alone: new RegExp(`${folder}(?![\\w\\-]|\\.\\w|\\.\\.|[\\\\/]+[^\\s])`, flags),
  };
}

/**
 * `text` with every absolute path of a file of the product at `root` made relative to it, and
 * the product's own folder written `.`.
 */
export function relativizeProductPaths(text: string, root: string | undefined): string {
  if (root === undefined || text === "") return text;
  const patterns = rootPatterns(root);
  if (patterns === undefined) return text;
  return text
    .replace(patterns.inside, (whole, rest: string) => {
      const relative = rest.replace(/\\+/g, "/");
      return relative.split("/").includes("..") ? whole : relative;
    })
    .replace(patterns.alone, ".");
}

/** The fields of a checkpoint the creator reads, with the product's absolute paths made relative. */
export function relativizeCheckpointText<T extends Partial<OpenCheckpointInput>>(
  fields: T,
  root: string | undefined,
): T {
  if (root === undefined) return fields;
  const fix = (text: string) => relativizeProductPaths(text, root);
  const card = fields.card;
  return {
    ...fields,
    ...(fields.title === undefined ? {} : { title: fix(fields.title) }),
    ...(fields.summary === undefined ? {} : { summary: fix(fields.summary) }),
    ...(fields.options === undefined
      ? {}
      : {
          options: fields.options.map((option) => ({
            ...option,
            label: fix(option.label),
            consequence: fix(option.consequence),
          })),
        }),
    ...(card === undefined
      ? {}
      : {
          card: {
            ...card,
            effect: fix(card.effect),
            ...(card.risks === undefined ? {} : { risks: card.risks.map(fix) }),
            ...(card.opinions === undefined
              ? {}
              : { opinions: card.opinions.map((o) => ({ ...o, view: fix(o.view) })) }),
            ...(card.why === undefined
              ? {}
              : {
                  why: {
                    ...card.why,
                    reason: fix(card.why.reason),
                    ...(card.why.rejected === undefined
                      ? {}
                      : { rejected: fix(card.why.rejected) }),
                  },
                }),
          },
        }),
  };
}
