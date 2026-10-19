import { ErrorCode, RULE_ACTIONS } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  initCommand,
  type MainBranchReader,
  readAutonomyState,
  resolveProfile,
  setAutonomyDial,
  setPermissionRule,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const CONFIG = ".agentplugged/method.yaml";

function context(files: MemoryFiles): CommandContext {
  return {
    files,
    tools: {
      which: async () => undefined,
      version: async () => "1.0.0",
      extensions: async () => [],
    },
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
  };
}

async function product(): Promise<MemoryFiles> {
  const files = new MemoryFiles();
  const result = await initCommand.run(context(files), { profile: resolveProfile("new-product") });
  if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
  return files;
}

/** A main branch holding `text` as its `method.yaml`. */
const mainWith = (text: string): MainBranchReader => ({
  read: async () => ({ found: true, branch: "main", text }),
});

async function state(files: MemoryFiles, reader?: MainBranchReader) {
  const read = await readAutonomyState(files, reader);
  if (read instanceof Error) throw read;
  return read;
}

describe("the autonomy dial on a product's files", () => {
  it("reads a freshly initialised product as Prudent: what the engine writes by default is the first notch", async () => {
    const files = await product();
    const read = await state(files);
    expect(read.dial).toBe("prudent");
    expect(read.mode).toBe("chat");
    expect(read.in_force).toBeUndefined();
    expect(Object.keys(read.rules).sort()).toEqual([...RULE_ACTIONS].sort());
  });

  it("writes every setting of a notch with the engine's writers, and reads the notch back", async () => {
    const files = await product();
    for (const dial of ["prudent", "balanced", "wide"] as const) {
      const done = await setAutonomyDial(files, dial);
      expect(done).toEqual({ written: true });
      expect((await state(files)).dial).toBe(dial);
    }
    const wide = await state(files);
    expect(wide.mode).toBe("auto");
    expect(wide.installs).toBe("visible");
    expect(wide.rules.internet).toBe("allow");
    // A second time changes nothing.
    expect(await setAutonomyDial(files, "wide")).toEqual({ written: false });
  });

  it("never moves the merge, the release or the publications, nor the guards", async () => {
    const files = await product();
    await setAutonomyDial(files, "prudent");
    const before = await state(files);
    expect(before.kept).toEqual(
      expect.arrayContaining([
        "framing",
        "architecture",
        "breakdown",
        "merge",
        "release",
        "publication",
      ]),
    );
    await setAutonomyDial(files, "wide");
    const after = await state(files);
    expect(after.kept).toEqual(["merge", "release", "publication"]);
    expect(after.rules.push_main).toBe("deny");
    expect(after.rules.force_push).toBe("deny");
    expect(after.rules.read_secrets).toBe("deny");
    expect(after.rules.destructive_command).toBe("deny");
    expect(after.rules.read_files).toBe(before.rules.read_files);
  });

  it("keeps the points the creator had chosen outside the dial", async () => {
    const files = await product();
    const text = await files.readText(CONFIG);
    await files.writeText(CONFIG, `${text}\nvalidation:\n  points: [merge]\n`);
    await setAutonomyDial(files, "balanced");
    expect((await state(files)).kept).toEqual(["framing", "architecture", "merge"]);
  });

  it("refuses to loosen a locked rule or to allow the commands that erase data", async () => {
    const files = await product();
    for (const action of ["push_main", "force_push", "read_secrets"] as const) {
      const refused = await setPermissionRule(files, action, "allow");
      expect(refused).toMatchObject({ code: ErrorCode.RULE_LOCKED });
    }
    expect(await setPermissionRule(files, "destructive_command", "allow")).toMatchObject({
      code: ErrorCode.RULE_LOCKED,
    });
    expect(await setPermissionRule(files, "destructive_command", "ask")).toEqual({ written: true });
    expect((await state(files)).rules.destructive_command).toBe("ask");
  });

  it("sets and tightens a free rule", async () => {
    const files = await product();
    expect(await setPermissionRule(files, "internet", "deny")).toEqual({ written: true });
    expect((await state(files)).rules.internet).toBe("deny");
    expect(await setPermissionRule(files, "internet", "deny")).toEqual({ written: false });
  });

  it("says what is in force when the engine reads another main branch", async () => {
    const files = await product();
    const onMain = await files.readText(CONFIG);
    await setAutonomyDial(files, "wide");
    const read = await state(files, mainWith(onMain));
    expect(read.dial).toBe("wide");
    expect(read.in_force?.dial).toBe("prudent");
    expect(read.in_force?.rules).toEqual({});
    // Once the main branch holds the notch, nothing is pending.
    const merged = await state(files, mainWith(await files.readText(CONFIG)));
    expect(merged.in_force).toBeUndefined();
  });
  it("reports an unreadable file instead of writing over it", async () => {
    const files = new MemoryFiles();
    await files.writeText(CONFIG, "not: [valid");
    expect(await setAutonomyDial(files, "wide")).toBeInstanceOf(Error);
    expect(await files.readText(CONFIG)).toBe("not: [valid");
  });
});
