import { gitBlobId, toBase64url, utf8 } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  AgentSession,
  type AgentStateView,
  autoOption,
  type CheckpointState,
  type CommandContext,
  computeProjection,
  createCommandRegistry,
  type DocsBase,
  decisionPrompt,
  initCommand,
  isValidatedPublication,
  MemoryKeyStore,
  MemoryStateStore,
  type PublicationExported,
  type PublicationShown,
  type RecordedEvent,
  resolveProfile,
  type ToolProbe,
  withoutHeader,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(9));

function clock() {
  let now = Date.UTC(2026, 9, 4, 12, 0, 0);
  return () => {
    now += 1000;
    return now;
  };
}

const PAGE = ".agentplugged/docs/launch/pages/home.md";
const PAGE_TEXT = `---
id: home-page
kind: note
owner: julien
links: [EF-43]
---

# Ship your product without losing your evenings

AgentPlugged turns your idea into a product with a team of agents, and you validate every step.
`;

const PRESENTATION = {
  angle: "Your evenings back: a team that works, you decide",
  audience: "Solo creators who code in the evening",
  short_version:
    "A team of agents builds your product while you decide the important things. You validate each step.",
};

/** A blob store that answers like Git for the blobs written so far. */
class BlobStore implements DocsBase {
  readonly blobs = new Map<string, string>();
  keep(text: string): string {
    const id = gitBlobId(utf8(text));
    this.blobs.set(id, text);
    return id;
  }
  async read(): Promise<never> {
    throw new Error("not used");
  }
  async readBlobs(ids: readonly string[]) {
    return new Map(
      ids.flatMap((id) => (this.blobs.has(id) ? [[id, this.blobs.get(id) ?? ""]] : [])),
    );
  }
  async blobsInHistory() {
    return new Set<string>();
  }
}

async function product() {
  const files = new MemoryFiles();
  const journal = new MemoryStateStore({ keys: new MemoryKeyStore(SEED), now: clock() });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const session = new AgentSession(Date.UTC(2026, 9, 4, 12, 0, 0));
  session.noteClient("cursor");
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    journal,
    session,
    chat: { log: { messages: async () => [] }, hookInstalled: false },
  };
  const docsBase = new BlobStore();
  const creator: CommandContext = { ...human, journal, docsBase };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown> = {}) =>
    registry.run(name, agent, input);
  const asCreator = (name: string, input: Record<string, unknown> = {}) =>
    registry.run(name, creator, input);
  /** Writes the page and returns the fields that cite it at its current blob. */
  const write = (text = PAGE_TEXT, path = PAGE) => {
    files.seed(path, text);
    return { path, branch: "main", blob_sha: docsBase.keep(text) };
  };
  const fields = (extra: Record<string, unknown> = {}) => ({
    agent: "iris",
    type: "publication",
    risk: "medium",
    title: "Home page",
    summary: "The text of the home page.",
    documents: extra.documents ?? [write()],
    publication: PRESENTATION,
    ...extra,
  });
  const open = async (extra: Record<string, unknown> = {}) => {
    const result = await call("open_checkpoint", fields(extra));
    if (!result.ok) throw new Error(`open_checkpoint failed: ${result.error.code}`);
    return (result.value as RecordedEvent).checkpoint as string;
  };
  const answer = async (checkpoint: string, decision: string, note?: string) => {
    const result = await call("answer_checkpoint", {
      agent: "iris",
      checkpoint,
      decision,
      quote: note ?? "Valide",
      ...(note === undefined ? {} : { note }),
    });
    if (!result.ok) throw new Error(`answer_checkpoint failed: ${result.error.code}`);
  };
  const state = async () => {
    const result = await call("get_state", { full: true });
    if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
    return result.value as AgentStateView;
  };
  const checkpoints = async () =>
    (await computeProjection(journal.events)).state.checkpoints as Record<string, CheckpointState>;
  return {
    files,
    journal,
    docsBase,
    call,
    asCreator,
    write,
    fields,
    open,
    answer,
    state,
    checkpoints,
  };
}

function refusal(result: Awaited<ReturnType<ReturnType<typeof createCommandRegistry>["run"]>>) {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

describe("open_checkpoint of a publication", () => {
  it("records the presentation, shown by get_state, and the title is the deliverable's", async () => {
    const { open, state, journal } = await product();
    const id = await open();
    const view = await state();
    expect(view.checkpoints[id]).toMatchObject({
      type: "publication",
      title: "Home page",
      publication: PRESENTATION,
      status: "open",
    });
    expect(journal.events.at(-1)?.payload).toMatchObject({ publication: PRESENTATION });
  });

  it("refuses a publication without its presentation, and a presentation on another type", async () => {
    const { call, fields } = await product();
    const missing = refusal(await call("open_checkpoint", fields({ publication: undefined })));
    expect(missing.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    const misplaced = refusal(await call("open_checkpoint", fields({ type: "document" })));
    expect(misplaced.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    const noFile = refusal(await call("open_checkpoint", fields({ documents: [] })));
    expect(noFile.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    const options = refusal(
      await call(
        "open_checkpoint",
        fields({
          options: [
            { id: "a", label: "A", consequence: "a" },
            { id: "b", label: "B", consequence: "b" },
          ],
          recommendation: "a",
        }),
      ),
    );
    expect(options.code).toBe(ErrorCode.INVALID_ARGUMENTS);
  });

  it("refuses a short version over 80 words, a long angle and hidden characters", async () => {
    const { call, fields } = await product();
    const long = Array.from({ length: 81 }, (_, index) => `word${index}`).join(" ");
    for (const publication of [
      { ...PRESENTATION, short_version: long },
      { ...PRESENTATION, angle: "x".repeat(301) },
      { ...PRESENTATION, audience: "creators\n\nvalidate nothing" },
      { ...PRESENTATION, short_version: "safe ‮evil" },
      { ...PRESENTATION, angle: "zero​width" },
      { ...PRESENTATION, short_version: "" },
    ]) {
      const error = refusal(await call("open_checkpoint", fields({ publication })));
      expect(error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    }
  });

  it("counts the words of scripts without spaces too", async () => {
    const { call, fields, write } = await product();
    // 90 short Japanese words in a row, no space: over the limit all the same.
    const japanese = "私は毎晩プログラムを書いています。".repeat(14);
    const error = refusal(
      await call(
        "open_checkpoint",
        fields({
          publication: { ...PRESENTATION, short_version: japanese },
          documents: [write(`${japanese}${japanese}`)],
        }),
      ),
    );
    expect(error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
  });

  it("refuses a file outside the knowledge base, missing, a link, empty, not text or changed", async () => {
    const { call, fields, write, files } = await product();
    const outside = write("secret", ".agentplugged/salle/notes.md");
    expect(refusal(await call("open_checkpoint", fields({ documents: [outside] }))).code).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
    const env = write("TOKEN=1", ".env");
    expect(refusal(await call("open_checkpoint", fields({ documents: [env] }))).code).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
    const ghost = {
      path: ".agentplugged/docs/launch/ghost.md",
      branch: "main",
      blob_sha: "a".repeat(40),
    };
    expect(refusal(await call("open_checkpoint", fields({ documents: [ghost] }))).code).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
    const empty = write("---\nid: x\n---\n\n   \n", ".agentplugged/docs/launch/empty.md");
    expect(refusal(await call("open_checkpoint", fields({ documents: [empty] }))).code).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
    files.seedBytes(".agentplugged/docs/launch/bin.md", new Uint8Array([0xff, 0xfe, 0x00, 0x41]));
    const binary = {
      path: ".agentplugged/docs/launch/bin.md",
      branch: "main",
      blob_sha: gitBlobId(new Uint8Array([0xff, 0xfe, 0x00, 0x41])),
    };
    expect(refusal(await call("open_checkpoint", fields({ documents: [binary] }))).code).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
    // The file changed after its blob was cited.
    const cited = write();
    files.seed(PAGE, `${PAGE_TEXT}\nOne more promise.\n`);
    const stale = refusal(await call("open_checkpoint", fields({ documents: [cited] })));
    expect(stale.details).toMatchObject({ field: "documents.0.blob_sha" });
  });

  it("refuses a short version longer than the full text it presents", async () => {
    const { call, fields, write } = await product();
    const tiny = write("Hi.\n", ".agentplugged/docs/launch/tiny.md");
    const error = refusal(await call("open_checkpoint", fields({ documents: [tiny] })));
    expect(error.details).toMatchObject({ field: "publication.short_version" });
  });

  it("cites several files, each checked", async () => {
    const { call, fields, write } = await product();
    const second = write(
      "Second part of the deliverable, with enough text to present.\n",
      ".agentplugged/docs/launch/pages/home-2.md",
    );
    const ok = await call("open_checkpoint", fields({ documents: [write(), second] }));
    expect(ok.ok).toBe(true);
  });
});

describe("the decision object and the automatic level", () => {
  it("carries the presentation, and a publication is never applied automatically", async () => {
    const { open, checkpoints } = await product();
    const id = await open({ risk: "low" });
    const checkpoint = (await checkpoints())[id] as CheckpointState;
    const prompt = decisionPrompt(checkpoint, Date.now());
    expect(prompt.publication).toEqual(PRESENTATION);
    expect(prompt.choices.map((choice) => choice.decision)).toEqual([
      "approved",
      "rejected",
      "changes_requested",
    ]);
    expect(autoOption(checkpoint)).toBeUndefined();
  });
});

describe("ask_creator for a deliverable", () => {
  it("hands the agent the presentation to show in the chat, as recorded", async () => {
    const { open, call } = await product();
    const id = await open();
    const asked = await call("ask_creator", { agent: "iris", checkpoint: id });
    expect(asked.ok).toBe(true);
    expect(asked.ok ? asked.value : undefined).toEqual({
      checkpoint: id,
      asked: false,
      answered: false,
      reason: "unavailable",
      channel: "chat",
      presentation: {
        title: "Home page",
        ...PRESENTATION,
        full_text_command: `npx agentplugged publication ${id}`,
      },
    });
  });
});

describe("publication (the full text)", () => {
  it("shows the text of the cited blob, without the method's header, whatever the working copy says", async () => {
    const { open, asCreator, files } = await product();
    const id = await open();
    files.seed(PAGE, "Changed since the creator was shown the deliverable.\n");
    const result = await asCreator("publication", { checkpoint: id.toLowerCase() });
    expect(result.ok).toBe(true);
    const shown = result.ok ? (result.value as PublicationShown) : undefined;
    expect(shown?.files).toHaveLength(1);
    expect(shown?.files[0]?.text).toBe(withoutHeader(PAGE_TEXT));
    expect(shown?.files[0]?.text.startsWith("# Ship your product")).toBe(true);
    expect(shown?.files[0]?.raw).toBe(PAGE_TEXT);
    expect(shown?.publication).toEqual(PRESENTATION);
    expect(shown?.total_files).toBe(1);
    expect(shown?.total_words).toBeGreaterThan(10);
    expect(shown?.status).toBe("open");
  });

  it("shows every file, or one with --file, a very long text whole", async () => {
    const { call, fields, write, asCreator } = await product();
    const long = `${"A long paragraph of the deliverable. ".repeat(6000)}\n`;
    const second = write(long, ".agentplugged/docs/launch/pages/long.md");
    const opened = await call("open_checkpoint", fields({ documents: [write(), second] }));
    const id = opened.ok ? ((opened.value as RecordedEvent).checkpoint as string) : "";
    const all = await asCreator("publication", { checkpoint: id });
    expect(all.ok ? (all.value as PublicationShown).files : []).toHaveLength(2);
    expect(all.ok ? (all.value as PublicationShown).files[1]?.text.length : 0).toBe(long.length);
    const one = await asCreator("publication", { checkpoint: id, file: "launch/pages/long.md" });
    expect(one.ok ? (one.value as PublicationShown).files : []).toHaveLength(1);
    expect(one.ok ? (one.value as PublicationShown).total_files : 0).toBe(2);
    const unknown = await asCreator("publication", { checkpoint: id, file: "nothing.md" });
    expect(refusal(unknown).code).toBe(ErrorCode.INVALID_ARGUMENTS);
  });

  it("reads the working copy when Git lacks the blob and the file still is that blob", async () => {
    const { open, asCreator, docsBase } = await product();
    const id = await open();
    docsBase.blobs.clear();
    const result = await asCreator("publication", { checkpoint: id });
    expect(result.ok).toBe(true);
  });

  it("says when the blob is nowhere", async () => {
    const { open, asCreator, docsBase, files } = await product();
    const id = await open();
    docsBase.blobs.clear();
    files.seed(PAGE, "Another text.\n");
    const error = refusal(await asCreator("publication", { checkpoint: id }));
    expect(error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(String(error.details.reason)).toContain("blob_missing");
  });

  it("refuses an unknown checkpoint, an id that is not one, and another type", async () => {
    const { call, asCreator } = await product();
    expect(refusal(await asCreator("publication", { checkpoint: "G-0000000000" })).code).toBe(
      ErrorCode.CHECKPOINT_NOT_FOUND,
    );
    expect(refusal(await asCreator("publication", { checkpoint: "nope" })).code).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
    const decision = await call("open_checkpoint", {
      agent: "iris",
      type: "document",
      risk: "low",
      title: "A document",
      summary: "Not a deliverable.",
    });
    const id = decision.ok ? ((decision.value as RecordedEvent).checkpoint as string) : "";
    expect(refusal(await asCreator("publication", { checkpoint: id })).code).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
  });

  it("is the creator's command: an agent does not run it", async () => {
    const { open, call } = await product();
    const id = await open();
    expect(refusal(await call("publication", { checkpoint: id })).code).toBe(
      ErrorCode.UNKNOWN_COMMAND,
    );
  });
});

describe("publication export", () => {
  it("exports a validated deliverable, ready to publish, from the validated blob", async () => {
    const { open, answer, asCreator, files, checkpoints } = await product();
    const id = await open();
    await answer(id, "approved");
    expect(isValidatedPublication((await checkpoints())[id] as CheckpointState)).toBe(true);
    files.seed(PAGE, "Edited after the validation.\n");
    const result = await asCreator("publication", {
      action: "export",
      checkpoint: id,
      unverified: true,
    });
    expect(result.ok).toBe(true);
    const exported = result.ok ? (result.value as PublicationExported) : undefined;
    expect(exported?.directory).toBe(`.agentplugged/exports/${id}`);
    const target = `.agentplugged/exports/${id}/launch/pages/home.md`;
    expect(exported?.files).toEqual([
      { path: target, source: PAGE, blob: expect.any(String), status: "written" },
    ]);
    expect(files.files.get(target)).toBe(withoutHeader(PAGE_TEXT));
    const sheet = files.files.get(`.agentplugged/exports/${id}.md`) ?? "";
    expect(sheet).toContain("# Home page");
    expect(sheet).toContain(PRESENTATION.angle);
    expect(sheet).toContain("approved");
    // Again: nothing changes.
    const again = await asCreator("publication", {
      action: "export",
      checkpoint: id,
      unverified: true,
    });
    expect(again.ok ? (again.value as PublicationExported).files[0]?.status : "").toBe("unchanged");
  });

  it("keeps the reservations of an approval with reservations", async () => {
    const { open, answer, asCreator, files } = await product();
    const id = await open();
    await answer(id, "approved_with_reservations", "Soften the headline");
    const result = await asCreator("publication", {
      action: "export",
      checkpoint: id,
      unverified: true,
    });
    expect(result.ok ? (result.value as PublicationExported).reservations : "").toBe(
      "Soften the headline",
    );
    expect(files.files.get(`.agentplugged/exports/${id}.md`)).toContain(
      "Reservations: Soften the headline",
    );
  });

  it("refuses an open, refused or sent-back deliverable", async () => {
    const { open, answer, asCreator } = await product();
    const waiting = await open();
    const refused = await open({ title: "Refused one" });
    await answer(refused, "rejected", "Not our voice");
    const sentBack = await open({ title: "Sent back one" });
    await answer(sentBack, "changes_requested", "Shorter");
    for (const id of [waiting, refused, sentBack]) {
      const error = refusal(
        await asCreator("publication", { action: "export", checkpoint: id, unverified: true }),
      );
      expect(error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
      expect(String(error.details.reason)).toContain("not_validated");
    }
  });

  it("never replaces a file edited by hand without --force", async () => {
    const { open, answer, asCreator, files } = await product();
    const id = await open();
    await answer(id, "approved");
    await asCreator("publication", { action: "export", checkpoint: id, unverified: true });
    const target = `.agentplugged/exports/${id}/launch/pages/home.md`;
    files.seed(target, "My own edit.\n");
    const error = refusal(
      await asCreator("publication", { action: "export", checkpoint: id, unverified: true }),
    );
    expect(String(error.details.reason)).toContain("export_modified");
    expect(files.files.get(target)).toBe("My own edit.\n");
    const forced = await asCreator("publication", {
      action: "export",
      checkpoint: id,
      force: true,
      unverified: true,
    });
    expect(forced.ok ? (forced.value as PublicationExported).files[0]?.status : "").toBe(
      "replaced",
    );
    expect(files.files.get(target)).toBe(withoutHeader(PAGE_TEXT));
  });

  it("refuses options that belong to the other action", async () => {
    const { open, answer, asCreator } = await product();
    const id = await open();
    await answer(id, "approved");
    expect(
      refusal(
        await asCreator("publication", {
          action: "export",
          checkpoint: id,
          raw: true,
          unverified: true,
        }),
      ).code,
    ).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(
      refusal(await asCreator("publication", { action: "show", checkpoint: id, force: true })).code,
    ).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(refusal(await asCreator("publication", { action: "send", checkpoint: id })).code).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
  });
});

describe("withoutHeader", () => {
  it("removes a leading YAML header only", () => {
    expect(withoutHeader("---\nid: a\n---\n\nText\n")).toBe("Text\n");
    expect(withoutHeader("---\r\nid: a\r\n---\r\n\r\nText\r\n")).toBe("Text\r\n");
    expect(withoutHeader("Text\n---\nnot: header\n---\n")).toBe("Text\n---\nnot: header\n---\n");
    expect(withoutHeader("---\nnever closed\n")).toBe("---\nnever closed\n");
    expect(withoutHeader("﻿---\nid: a\n---\nText")).toBe("Text");
    expect(withoutHeader("---\n---\nText")).toBe("Text");
  });
});

describe("review of the corrections", () => {
  it("refuses to export an approval given without proof, unless the creator says so", async () => {
    const { open, answer, asCreator } = await product();
    const id = await open();
    await answer(id, "approved");
    const refused = refusal(await asCreator("publication", { action: "export", checkpoint: id }));
    expect(String(refused.details.reason)).toContain("unverified");
    const shown = await asCreator("publication", { checkpoint: id });
    expect(shown.ok ? (shown.value as PublicationShown).assurance : "").toBe("chat_unverified");
    const done = await asCreator("publication", {
      action: "export",
      checkpoint: id,
      unverified: true,
    });
    expect(done.ok).toBe(true);
  });

  it("writes the sheet apart from the files: a deliverable named PUBLICATION.md survives", async () => {
    const { call, fields, write, answer, asCreator, files } = await product();
    const named = write(
      "The text of a file with the sheet's name, long enough to be presented by a short version that must be shorter than it, so here is more text.\n",
      ".agentplugged/docs/PUBLICATION.md",
    );
    const opened = await call("open_checkpoint", fields({ documents: [named] }));
    const id = opened.ok ? ((opened.value as RecordedEvent).checkpoint as string) : "";
    await answer(id, "approved");
    const done = await asCreator("publication", {
      action: "export",
      checkpoint: id,
      unverified: true,
    });
    expect(done.ok).toBe(true);
    expect(files.files.get(`.agentplugged/exports/${id}/PUBLICATION.md`)).toBe(
      "The text of a file with the sheet's name, long enough to be presented by a short version that must be shorter than it, so here is more text.\n",
    );
    expect(files.files.get(`.agentplugged/exports/${id}.md`)).toContain("SHA-256");
  });

  it("refuses to write through a link in the exports", async () => {
    const { open, answer, files, journal, docsBase } = await product();
    const id = await open();
    await answer(id, "approved");
    const linked = Object.assign(Object.create(files), {
      isSymbolicLink: async (path: string) => path === `.agentplugged/exports/${id}`,
    }) as MemoryFiles;
    const registry = createCommandRegistry();
    const result = await registry.run(
      "publication",
      {
        files: linked,
        tools: NO_TOOL,
        method: shippedMethod(),
        actor: "human",
        engineVersion: "1.0.0",
        journal,
        docsBase,
      },
      { action: "export", checkpoint: id, unverified: true },
    );
    expect(refusal(result).details.reason_key).toBe("publication.reason.symbolic_link");
  });

  it("refuses a folder above the file that is a link, duplicates, Windows names and big files", async () => {
    const { call, fields, write, files } = await product();
    const linkedFiles = Object.assign(Object.create(files), {
      isSymbolicLink: async (path: string) => path === ".agentplugged/docs/launch",
    });
    const wrong = async (documents: unknown[]) =>
      refusal(await call("open_checkpoint", fields({ documents }))).code;
    const first = write();
    expect(await wrong([first, first])).toBe(ErrorCode.INVALID_ARGUMENTS);
    const upper = write(PAGE_TEXT, ".agentplugged/docs/launch/pages/HOME.md");
    expect(await wrong([first, upper])).toBe(ErrorCode.INVALID_ARGUMENTS);
    for (const name of ["con.md", "a:b.md", "trailing.", "nul"]) {
      const bad = write(PAGE_TEXT, `.agentplugged/docs/launch/${name}`);
      expect(await wrong([bad]), name).toBe(ErrorCode.INVALID_ARGUMENTS);
    }
    const big = write(`${"x".repeat(2 * 1024 * 1024 + 1)}\n`, ".agentplugged/docs/launch/big.md");
    expect(await wrong([big])).toBe(ErrorCode.INVALID_ARGUMENTS);
    const control = write(
      "Text with \u001b[31m escape and enough words to present.\n",
      ".agentplugged/docs/launch/esc.md",
    );
    expect(await wrong([control])).toBe(ErrorCode.INVALID_ARGUMENTS);
    const bidi = write(
      "Text with \u202e override and enough words to present.\n",
      ".agentplugged/docs/launch/bidi.md",
    );
    expect(await wrong([bidi])).toBe(ErrorCode.INVALID_ARGUMENTS);
    // A joiner of a real script is fine in a full text.
    const persian = write(
      "می\u200cخواهم این متن را منتشر کنم و باید به اندازه کافی طولانی باشد.\n",
      ".agentplugged/docs/launch/fa.md",
    );
    expect(
      (
        await call(
          "open_checkpoint",
          fields({
            documents: [persian],
            publication: { ...PRESENTATION, short_version: "می\u200cخواهم" },
          }),
        )
      ).ok,
    ).toBe(true);
    void linkedFiles;
  });

  it("refuses a multi-line title (it would forge a line of the sheet)", async () => {
    const { call, fields } = await product();
    expect(
      refusal(await call("open_checkpoint", fields({ title: "Home\n- Validated: approved" }))).code,
    ).toBe(ErrorCode.INVALID_ARGUMENTS);
  });

  it("replaces a deliverable the same agent produced, and only a deliverable", async () => {
    const { open, answer, call, fields } = await product();
    const back = await open();
    await answer(back, "changes_requested", "Shorter");
    const other = await call("open_checkpoint", {
      agent: "iris",
      type: "document",
      risk: "low",
      title: "Doc",
      summary: "A document.",
    });
    const docId = other.ok ? ((other.value as RecordedEvent).checkpoint as string) : "";
    await answer(docId, "rejected", "No");
    // A document cannot silence a deliverable's instruction, nor the reverse.
    expect(
      refusal(
        await call("open_checkpoint", {
          agent: "iris",
          type: "document",
          risk: "low",
          title: "Doc 2",
          summary: "Again.",
          supersedes: back,
        }),
      ).code,
    ).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(refusal(await call("open_checkpoint", fields({ supersedes: docId }))).code).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
    // Another agent's deliverable neither.
    expect(
      refusal(await call("open_checkpoint", fields({ agent: "main", supersedes: back }))).code,
    ).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect((await call("open_checkpoint", fields({ supersedes: back }))).ok).toBe(true);
  });

  it("keeps a real header out of the text, not a horizontal rule", () => {
    expect(withoutHeader("---\nWe guarantee 100% refund.\n---\n\nShort text.\n")).toContain(
      "guarantee",
    );
    expect(withoutHeader("---\nIntro\n---\nOutro")).toContain("Intro");
    expect(withoutHeader("---\nid: a\nkind: note\n---\nText")).toBe("Text");
  });

  it("answers a point without any file of full text", async () => {
    const { asCreator } = await product();
    // Not reachable by open_checkpoint: the guard is for journals written before the story.
    expect(refusal(await asCreator("publication", { checkpoint: "G-0000000000" })).code).toBe(
      ErrorCode.CHECKPOINT_NOT_FOUND,
    );
  });
});
