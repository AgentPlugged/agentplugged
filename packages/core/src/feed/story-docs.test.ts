import { PublishedStoryDocsSchema } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { MemoryKeyStore } from "../journal/key-store.js";
import { MemoryStateStore } from "../journal/memory-state-store.js";
import { readPublishedState } from "./published-state.js";
import { publishedStoryDocs, STORY_FILES_DIR } from "./story-docs.js";

const PRODUCT = "01K6KXJ5G0PR0DVCT00000000A";

function story(
  id: string,
  extra: { title?: string; depends?: string; body?: string } = {},
): string {
  const [epic] = id.split("-");
  return [
    "---",
    `id: ${id}`,
    "kind: story",
    "owner: sam",
    `title: ${extra.title ?? `Story ${id}`}`,
    `epic: epic-${epic}`,
    "reviewer: quentin",
    "requirements: [EF-1, EF-2]",
    "budget_usd: 2.5",
    `branch: feat/${id}-thing`,
    `depends_on: [${extra.depends ?? ""}]`,
    "---",
    `# Story ${id}`,
    "",
    "## Context",
    "",
    "Some context.",
    "",
    "## Intent",
    "",
    "Ada can do the thing.",
    "",
    "## Acceptance criteria",
    "",
    extra.body ?? "- First criterion.\n- Second criterion.",
    "",
    "## Out of scope",
    "",
    "Nothing.",
    "",
  ].join("\n");
}

const file = (id: string, text: string) => ({ path: `${STORY_FILES_DIR}/${id}-thing.md`, text });

describe("the story files a bridge publishes", () => {
  it("keeps the header, the intent and the criteria in order of each valid story", () => {
    const docs = publishedStoryDocs([
      file("1-2", story("1-2", { title: "Sign in", depends: "1-1" })),
      file("1-1", story("1-1")),
    ]);
    expect(Object.keys(docs).sort()).toEqual(["1-1", "1-2"]);
    expect(docs["1-2"]).toEqual({
      title: "Sign in",
      owner: "sam",
      epic: "epic-1",
      requirements: ["EF-1", "EF-2"],
      depends_on: ["1-1"],
      branch: "feat/1-2-thing",
      budget_usd: 2.5,
      intent: "Ada can do the thing.",
      criteria: ["First criterion.", "Second criterion."],
    });
    expect(PublishedStoryDocsSchema.safeParse(docs).success).toBe(true);
  });

  it("leaves out a file that is not a valid story, a file outside the stories folder, and a repeated id", () => {
    const docs = publishedStoryDocs([
      file("1-1", story("1-1")),
      file("1-2", "no header at all"),
      file("1-3", story("1-3").replace("reviewer: quentin\n", "")),
      { path: ".agentplugged/docs/1-4.md", text: story("1-4") },
      { path: `${STORY_FILES_DIR}/1-1-zcopy.md`, text: story("1-1", { title: "Copy" }) },
    ]);
    expect(Object.keys(docs)).toEqual(["1-1"]);
    expect(docs["1-1"]?.title).toBe("Story 1-1");
  });

  it("cuts a long intent and many criteria to the bounds of the schema", () => {
    const items = Array.from({ length: 60 }, (_, index) => `- Criterion ${index + 1}`).join("\n");
    const docs = publishedStoryDocs([file("1-1", story("1-1", { body: items }))]);
    expect(docs["1-1"]?.criteria).toHaveLength(40);
    const long = story("1-1").replace("Ada can do the thing.", "word ".repeat(600));
    const cutDocs = publishedStoryDocs([file("1-1", long)]);
    expect(cutDocs["1-1"]?.intent.length).toBeLessThanOrEqual(1200);
    expect(PublishedStoryDocsSchema.safeParse(cutDocs).success).toBe(true);
  });

  it("publishes nothing for no file", () => {
    expect(publishedStoryDocs([])).toEqual({});
  });

  it("puts the key in the open state of the published state, and leaves it out without a story", async () => {
    const keys = new MemoryKeyStore();
    const store = new MemoryStateStore({ keys });
    await store.append({
      type: "git.workflow_set",
      actor: { kind: "system" },
      product: PRODUCT,
      provenance: "trusted",
      payload: { workflow: {}, previous: null, source: "init", forge: false },
    });
    const bare = await readPublishedState(store, PRODUCT);
    expect(bare.state.projection.state.story_docs).toBeUndefined();
    const read = await readPublishedState(store, PRODUCT, {
      storyFiles: [file("1-1", story("1-1"))],
    });
    expect(read.state.projection.state.story_docs).toEqual(
      publishedStoryDocs([file("1-1", story("1-1"))]),
    );
  });
});
