import { fromUtf8 } from "@agentplugged/crypto";
import type { StoryHeader } from "@agentplugged/protocol";
import { checkDocuments } from "../docs/check-docs.js";
import type { DocumentFile } from "../docs/docs-base.js";
import { DOCUMENT_PATHS, isDocumentPath, knownOwners } from "../docs/docs-command.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { storiesOf } from "../docs/story-rules.js";
import { readWorkingBytes } from "../phases/design-review.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import type { SprintStory } from "./sprint-rules.js";

/** The story id a file name starts with (`1-2-sign-in.md` → `1-2`). */
function idOfName(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /^([1-9]\d{0,5}-[1-9]\d{0,5})(?![0-9])/.exec(name)?.[1];
}

/** The story ids a `docs check` problem is about: its file's story, or every story of a cycle. */
function storiesOfProblem(
  details: Readonly<Record<string, unknown>>,
  byPath: ReadonlyMap<string, string>,
): string[] {
  const cycle = details.cycle;
  if (Array.isArray(cycle)) return cycle.filter((id): id is string => typeof id === "string");
  const story = typeof details.path === "string" ? byPath.get(details.path) : undefined;
  return story === undefined ? [] : [story];
}

/**
 * The stories of the working copy (`.agentplugged/stories/`), by id, as a sprint needs them: the
 * first file of each id (`storiesOf`), its bytes (to compare with the blob a checkpoint
 * approved), and whether `docs check` refuses it. The whole working copy is checked as
 * `docs check` does, without its base: any problem in the story's file (contract, links,
 * sections, markers, a dependency on itself, a later or an unknown story) or a cycle it belongs
 * to makes it invalid, with the codes. A story file that cannot be read is `unreadable`, under
 * the id its name starts with.
 */
export async function readSprintStories(files: WorkspaceFiles): Promise<Map<string, SprintStory>> {
  const current: DocumentFile[] = [];
  const bytesOf = new Map<string, Uint8Array>();
  const unreadable: string[] = [];
  for (const dir of DOCUMENT_PATHS) {
    for (const listed of (await files.listFiles(dir)).sort()) {
      const path = listed.replaceAll("\\", "/");
      if (!isDocumentPath(path)) continue;
      if ((await files.isSymbolicLink?.(listed)) === true) continue;
      const bytes = (await readWorkingBytes(files, listed)) ?? undefined;
      const text = bytes === undefined ? undefined : fromUtf8(bytes);
      if (bytes === undefined || text === undefined) {
        if (path.includes("/stories/")) unreadable.push(path);
        continue;
      }
      current.push({ path, text });
      bytesOf.set(path, bytes);
    }
  }
  const parsed = current.map((file) => parseDocumentFile(file.path, file.text));
  const stories = storiesOf(parsed.filter((document) => document.path.includes("/stories/")));
  const byPath = new Map([...stories].map(([id, document]) => [document.path, id]));
  const faults = new Map<string, Set<string>>();
  const problems = checkDocuments({ current, owners: await knownOwners(files) });
  for (const problem of problems) {
    for (const id of storiesOfProblem(problem.details, byPath)) {
      const codes = faults.get(id) ?? new Set<string>();
      codes.add(problem.code);
      faults.set(id, codes);
    }
  }
  const result = new Map<string, SprintStory>();
  for (const [id, document] of stories) {
    const header = document.header as StoryHeader | undefined;
    const codes = [...(faults.get(id) ?? [])].sort();
    const valid = header !== undefined && codes.length === 0;
    result.set(id, {
      id,
      path: document.path,
      state: valid ? "valid" : "invalid",
      faults: codes,
      bytes: bytesOf.get(document.path) ?? new Uint8Array(),
      owner: valid ? header.owner : undefined,
      budget_usd: valid ? header.budget_usd : undefined,
      depends_on: valid ? [...header.depends_on] : [],
      declared_depends_on: header === undefined ? [] : [...header.depends_on],
      branch: valid ? header.branch : undefined,
    });
  }
  for (const path of unreadable) {
    const id = idOfName(path);
    if (id === undefined || result.has(id)) continue;
    result.set(id, {
      id,
      path,
      state: "unreadable",
      faults: [],
      bytes: new Uint8Array(),
      owner: undefined,
      budget_usd: undefined,
      depends_on: [],
    });
  }
  return result;
}
