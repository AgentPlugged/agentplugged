import { gitBlobId, utf8 } from "@agentplugged/crypto";
import { describe, expect, it } from "vitest";
import type { DocsBase, DocsBaseRead } from "../docs/docs-base.js";
import { uncommittedDocuments } from "./phase-documents.js";

const TEXT = "# Brief\n\nHello.\n";
const cite = (path: string, text: string, branch = "main") => ({
  path,
  branch,
  blob_sha: gitBlobId(utf8(text)),
});

/** A base whose branches are given: `branches[name]` is path -> text; others are unknown. */
function base(
  branches: Record<string, Record<string, string>>,
  history: readonly string[] = [],
): DocsBase & { readonly refs: string[] } {
  const refs: string[] = [];
  return {
    refs,
    read: async (ref): Promise<DocsBaseRead> => {
      refs.push(ref);
      const files = branches[ref];
      return files === undefined
        ? { found: false, reason: "unknown_ref" }
        : {
            found: true,
            commit: "c".repeat(40),
            files: Object.entries(files).map(([path, text]) => ({ path, text })),
          };
    },
    readBlobs: async () => new Map(),
    blobsInHistory: async (ids) => new Set(ids.filter((id) => history.includes(id))),
  };
}

describe("uncommittedDocuments", () => {
  it("is empty for what is committed on the branch cited, and reads each branch once", async () => {
    const git = base({ main: { "a/x.md": TEXT, "b/y.md": TEXT } });
    expect(await uncommittedDocuments([cite("a/x.md", TEXT), cite("b/y.md", TEXT)], git)).toEqual(
      [],
    );
    expect(git.refs).toEqual(["main"]);
  });

  it("names a document absent from the branch, or committed with another content", async () => {
    const git = base({ main: { "a/x.md": `${TEXT}more\n` } });
    expect(await uncommittedDocuments([cite("a/x.md", TEXT), cite("a/z.md", TEXT)], git)).toEqual([
      "a/x.md",
      "a/z.md",
    ]);
  });

  it("looks at the branch cited, not another one", async () => {
    const git = base({ main: {}, feature: { "a/x.md": TEXT } });
    expect(await uncommittedDocuments([cite("a/x.md", TEXT, "feature")], git)).toEqual([]);
    expect(await uncommittedDocuments([cite("a/x.md", TEXT, "main")], git)).toEqual(["a/x.md"]);
  });

  it("falls back on the history for a branch Git does not know", async () => {
    const held = cite("a/x.md", TEXT, "gone");
    expect(await uncommittedDocuments([held], base({}, [held.blob_sha]))).toEqual([]);
    expect(await uncommittedDocuments([held], base({}))).toEqual(["a/x.md"]);
  });

  it("names a path once, reads a path written with a backslash, and a root file", async () => {
    const git = base({ main: { "a/x.md": TEXT, "README.md": TEXT } });
    expect(
      await uncommittedDocuments(
        [cite("a\\x.md", TEXT), cite("README.md", TEXT), cite("a/missing.md", TEXT)].concat([
          cite("a/missing.md", TEXT),
        ]),
        git,
      ),
    ).toEqual(["a/missing.md"]);
  });

  it("checks a document that is not Markdown against the history", async () => {
    const page = cite("a/page.html", "<p>x</p>");
    // The reader lists only Markdown files: the tree says nothing of an .html file.
    expect(await uncommittedDocuments([page], base({ main: {} }, [page.blob_sha]))).toEqual([]);
    expect(await uncommittedDocuments([page], base({ main: {} }))).toEqual(["a/page.html"]);
  });

  it("refuses nothing when Git fails or has no commit yet", async () => {
    const failing: DocsBase = {
      read: async () => {
        throw new Error("git: timed out");
      },
      readBlobs: async () => new Map(),
      blobsInHistory: async () => new Set(),
    };
    expect(await uncommittedDocuments([cite("a/x.md", TEXT)], failing)).toEqual([]);
    const empty: DocsBase = {
      ...failing,
      read: async () => ({ found: false, reason: "no_commit" }),
    };
    expect(await uncommittedDocuments([cite("a/x.md", TEXT)], empty)).toEqual([]);
  });

  it("refuses nothing without a reader or outside a repository", async () => {
    expect(await uncommittedDocuments([cite("a/x.md", TEXT)], undefined)).toEqual([]);
    const none: DocsBase = {
      read: async () => ({ found: false, reason: "no_repository" }),
      readBlobs: async () => new Map(),
      blobsInHistory: async () => new Set(),
    };
    expect(await uncommittedDocuments([cite("a/x.md", TEXT)], none)).toEqual([]);
  });
});
