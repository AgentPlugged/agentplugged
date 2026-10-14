import { utf8 } from "@agentplugged/crypto";
import type { DocsBase } from "../docs/docs-base.js";
import { isBlobOf } from "./design-review.js";

/** A document a checkpoint cites: where it is, on which branch, and at which Git blob. */
export interface CitedDocument {
  readonly path: string;
  readonly branch: string;
  readonly blob_sha: string;
}

/** A path with `/` as separator. */
function normalized(path: string): string {
  return path.replaceAll("\\", "/");
}

/** The folder of a path, `.` at the root. */
function folderOf(path: string): string {
  const at = normalized(path).lastIndexOf("/");
  return at === -1 ? "." : normalized(path).slice(0, at);
}

/**
 * The documents the end of a phase cites must be committed on the branch they name.
 * A blob made with `git hash-object -w` on an untracked file is in Git's object store but in no
 * commit: the creator is shown a document nobody can find again, and a fresh clone lacks it. The
 * engine reads the tree of each branch cited and asks that the cited path hold exactly the cited
 * blob there (as written or with LF line endings). Git's reader only lists Markdown files, so
 * a document of another kind, and a branch Git does not know, are checked against the history of
 * the current branch instead (the blob was committed at some point).
 *
 * Returns the paths of the documents not on their branch, once each, in the order cited. Empty
 * when every one is, and when it cannot be known (no reader, no repository, no commit yet, Git
 * failing: nothing is refused for what Git cannot say).
 */
export async function uncommittedDocuments(
  documents: readonly CitedDocument[],
  docsBase: DocsBase | undefined,
): Promise<string[]> {
  if (docsBase === undefined || documents.length === 0) return [];
  const missing = new Set<string>();
  const inHistory = async (cited: readonly CitedDocument[]) => {
    const held = await docsBase.blobsInHistory(cited.map((document) => document.blob_sha));
    for (const document of cited) if (!held.has(document.blob_sha)) missing.add(document.path);
  };
  try {
    for (const branch of new Set(documents.map((document) => document.branch))) {
      const onBranch = documents.filter((document) => document.branch === branch);
      const markdown = onBranch.filter((document) => document.path.toLowerCase().endsWith(".md"));
      await inHistory(onBranch.filter((document) => !markdown.includes(document)));
      if (markdown.length === 0) continue;
      const folders = [...new Set(markdown.map((document) => folderOf(document.path)))];
      const read = await docsBase.read(branch, folders);
      if (read.found) {
        const files = new Map(read.files.map((file) => [normalized(file.path), file.text]));
        for (const document of markdown) {
          const text = files.get(normalized(document.path));
          if (text === undefined || !isBlobOf(document.blob_sha, utf8(text))) {
            missing.add(document.path);
          }
        }
      } else if (read.reason === "unknown_ref") {
        await inHistory(markdown);
      }
    }
  } catch {
    // Git failed (a timeout, a repository it refuses): nothing can be told, nothing is refused.
    return [];
  }
  return [...new Set(documents.map((document) => document.path))].filter((path) =>
    missing.has(path),
  );
}
