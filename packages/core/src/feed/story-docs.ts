import {
  PUBLISHED_STORY_CRITERIA_MAX,
  PUBLISHED_STORY_DOCS_MAX,
  PUBLISHED_STORY_LINE_MAX,
  PUBLISHED_STORY_TEXT_MAX,
  PublishedStoryDocSchema,
  type PublishedStoryDocs,
  type StoryHeader,
} from "@agentplugged/protocol";
import { DOCUMENT_PATHS, isDocumentPath } from "../docs/docs-command.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { intentOf, storiesOf } from "../docs/story-rules.js";
import { acceptanceCriteria } from "../stories/pull-request-body.js";

/**
 * What the story files of a product's working copy say, in the form the main bridge publishes
 * them: the title, owner, requirements, dependencies, branch and budget of the header, the intent
 * and the acceptance criteria in order. Pure: the bridge reads the files (inside the product's
 * folder) and hands their text here. A file that is not a valid story, or whose id another file
 * already took, is left out: nothing is guessed.
 */

/** A story file as read: its path in the working copy (with `/`) and its text. */
export interface StoryFileText {
  readonly path: string;
  readonly text: string;
}

/** The folder the story files live in, relative to the product's folder. */
export const STORY_FILES_DIR: string =
  DOCUMENT_PATHS.find((dir) => dir.endsWith("/stories")) ?? ".agentplugged/stories";

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function publishedStoryDocs(files: readonly StoryFileText[]): PublishedStoryDocs {
  const parsed = [...files]
    .filter((file) => isDocumentPath(file.path) && file.path.includes("/stories/"))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => parseDocumentFile(file.path, file.text));
  const docs: PublishedStoryDocs = {};
  let kept = 0;
  for (const [id, document] of storiesOf(parsed)) {
    const header = document.header as StoryHeader | undefined;
    if (header === undefined || kept >= PUBLISHED_STORY_DOCS_MAX) continue;
    const entry = {
      title: cut(header.title, PUBLISHED_STORY_LINE_MAX),
      owner: header.owner,
      epic: header.epic,
      requirements: header.requirements.slice(0, PUBLISHED_STORY_CRITERIA_MAX),
      depends_on: header.depends_on.slice(0, PUBLISHED_STORY_CRITERIA_MAX),
      branch: cut(header.branch, PUBLISHED_STORY_LINE_MAX),
      budget_usd: header.budget_usd,
      intent: cut(intentOf(document), PUBLISHED_STORY_TEXT_MAX),
      criteria: acceptanceCriteria(document)
        .slice(0, PUBLISHED_STORY_CRITERIA_MAX)
        .map((criterion) => cut(criterion, PUBLISHED_STORY_LINE_MAX)),
    };
    // What does not fit the schema the views read with is left out here, never published unreadable.
    if (!PublishedStoryDocSchema.safeParse(entry).success) continue;
    kept += 1;
    docs[id] = entry;
  }
  return docs;
}
