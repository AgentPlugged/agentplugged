/**
 * Stable English messages of the schema issues the creator may meet. Surfaces translate them
 * (core attaches a `reason_key`); the English text stays in `details.reason`.
 */
export const ISSUE = {
  menuCode: "1 to 12 letters, digits or -",
  skillOrPrompt: "exactly one of skill or prompt is required",
  duplicateCode: "duplicate code",
  notCustomisable: "defines the agent and cannot be customised",
  idFormat: "lowercase letters, digits and single hyphens",
  duplicateValue: "duplicate value",
  alsoEnabled: "also in agents.enabled",
  ulid: "expected a ULID (26 characters, uppercase Crockford base32)",
  docId: "lowercase letters, digits and hyphens",
  docKind: "brief, prd, ux, architecture, epic, story, note or decision",
  docLink: "a document id or a requirement identifier (EF-1, ENF-1, PU-1, MS-1, AD-1)",
  docStateKey: "the state comes from the journal, never from a document",
  oneLine: "must fit on one line",
  requirementId: "a requirement identifier (EF-1, ENF-1, PU-1, MS-1, AD-1)",
  storyId: "<epic>-<story>, for example 2-6",
  storyEpic: "the epic of the story's id: epic-<epic>, for example epic-2 for 2-6",
  storyRequirements: "at least one requirement identifier",
  budget: "an amount in US dollars above zero",
  branchName: "a Git branch name",
  epicId: "epic-<n>, for example epic-2",
  docSource:
    "a list of { path, blob }: the path of a document read, and the blob id of the version read (40 or 64 lowercase hexadecimal characters)",
  docSourceOutside:
    "a document of .agentplugged/docs/: stories, epics and other files are not tracked",
  docSourcePage: "a document of the method, never a page of the knowledge base",
  docSourceRelease: "release notes are a dated history: they record no sources",
  docCode: "a list of paths of the repository, relative to its top with /, a folder ending with /",
  docLastStory: "the id of a merged story, <epic>-<story>, for example 4-9",
  docDependencies:
    "a table of ecosystem (npm, pypi, crates, go, rubygems, packagist) to a list of package names, without versions, for example npm: [react, supabase]",
  docPrerequisites:
    "tools (a list of name, min, why), ports (a list of numbers) and memory_gb (a number), for example tools: [{ name: docker, min: 24 }], ports: [5432]",
} as const;

export type IssueName = keyof typeof ISSUE;

/** The name of a known issue message, or undefined. */
export function issueName(message: string | undefined): IssueName | undefined {
  return (Object.keys(ISSUE) as IssueName[]).find((name) => ISSUE[name] === message);
}
