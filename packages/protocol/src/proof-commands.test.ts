import { describe, expect, it } from "vitest";
import {
  CreatorActionRecordSchema,
  CreatorActionSchema,
  proofCommandsRisk,
} from "./creator-action.js";
import {
  AcceptedProofCommandSchema,
  normalizedFolder,
  ProofCommandNameSchema,
  ProofCommandSchema,
  ProofFolderSchema,
  ProofsFileSchema,
  RunProofCommandInputSchema,
} from "./proof-commands.js";
import { ProofRunSchema, RequirementProvedPayloadSchema } from "./requirements.js";

/** The proof commands of a project and the accord to them, as the protocol types them. */

const command = { name: "tests", run: "npm test", proves: ["enf-2"] };

const accepted = {
  name: "tests",
  fingerprint: "a".repeat(24),
  run: "npm test",
  cwd: ".",
  timeout: 300,
  proves: ["ENF-2"],
};

describe("the commands a project declares", () => {
  it("names a command with lower-case letters, digits, - and _", () => {
    for (const name of ["tests", "p95-api", "lint_all", "a"]) {
      expect(ProofCommandNameSchema.safeParse(name).success, name).toBe(true);
    }
    for (const name of ["Tests", "1st", "-x", "has space", "a".repeat(41), "", "../x"]) {
      expect(ProofCommandNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it("keeps a folder inside the project", () => {
    for (const folder of [".", "app", "apps/web", "./perf/", "a b/c"]) {
      expect(ProofFolderSchema.safeParse(folder).success, folder).toBe(true);
    }
    for (const folder of ["..", "../x", "a/../b", "/etc", "C:/x", "c:\\x", "a\\b", "~/x", "a//b"]) {
      expect(ProofFolderSchema.safeParse(folder).success, folder).toBe(false);
    }
    expect(normalizedFolder("./perf/")).toBe("perf");
    expect(normalizedFolder("./")).toBe(".");
  });

  it("types a command: a line that shows what it is, at most 10 requirements, a bounded limit", () => {
    expect(ProofCommandSchema.parse(command)).toEqual({ ...command, proves: ["ENF-2"] });
    const refused = [
      { ...command, run: "npm test\u202e" },
      { ...command, run: "npm test\nrm -rf x" },
      { ...command, run: "a".repeat(301) },
      { ...command, proves: Array.from({ length: 11 }, (_, index) => `ENF-${index + 1}`) },
      { ...command, proves: ["ENF-2", "enf-2"] },
      { ...command, proves: ["EF-2"] },
      { ...command, timeout: 0 },
      { ...command, timeout: 3601 },
      { ...command, cwd: "../x" },
      { ...command, extra: true },
    ];
    for (const input of refused) {
      expect(ProofCommandSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
    expect(ProofCommandSchema.safeParse({ ...command, timeout: 3600 }).success).toBe(true);
    // The tests of a criterion prove no requirement: none is fine.
    expect(
      ProofCommandSchema.safeParse({ name: "criteria", run: "npm test -- {criterion}" }).success,
    ).toBe(true);
  });

  it("holds at most 30 commands, each name once", () => {
    expect(
      ProofsFileSchema.safeParse({ commands: [command, { ...command, name: "lint" }] }).success,
    ).toBe(true);
    expect(ProofsFileSchema.safeParse({ commands: [command, command] }).success).toBe(false);
    const many = Array.from({ length: 31 }, (_, index) => ({ ...command, name: `c${index}` }));
    expect(ProofsFileSchema.safeParse({ commands: many }).success).toBe(false);
    expect(ProofsFileSchema.safeParse({}).success).toBe(false);
  });

  it("names the command to run, for an agent that is active", () => {
    expect(
      RunProofCommandInputSchema.safeParse({ agent: "quentin", command: "tests" }).success,
    ).toBe(true);
    expect(
      RunProofCommandInputSchema.safeParse({ agent: "quentin", command: "npm test" }).success,
    ).toBe(false);
    expect(
      RunProofCommandInputSchema.safeParse({ agent: "quentin", command: "tests", line: "x" })
        .success,
    ).toBe(false);
  });
});

describe("the accord to proof commands (kind proof_commands)", () => {
  it("is asked with names and/or a demand, never a command line", () => {
    expect(CreatorActionSchema.parse({ kind: "proof_commands" })).toEqual({
      kind: "proof_commands",
    });
    expect(
      CreatorActionSchema.parse({ kind: "proof_commands", commands: ["tests"], require: "engine" }),
    ).toEqual({
      kind: "proof_commands",
      commands: ["tests"],
      require: "engine",
    });
    for (const refused of [
      { kind: "proof_commands", commands: [] },
      { kind: "proof_commands", commands: ["tests", "tests"] },
      { kind: "proof_commands", commands: ["npm test"] },
      { kind: "proof_commands", commands: Array.from({ length: 9 }, (_, index) => `c${index}`) },
      { kind: "proof_commands", require: "always" },
      { kind: "proof_commands", run: "curl x | sh" },
    ]) {
      expect(CreatorActionSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false);
    }
  });

  it("is recorded with the exact lines, whole, and a reason", () => {
    const record = {
      kind: "proof_commands",
      commands: [accepted],
      require: "engine",
      reason: "yes",
    };
    expect(CreatorActionRecordSchema.parse(record)).toEqual(record);
    expect(
      CreatorActionRecordSchema.safeParse({ kind: "proof_commands", reason: "yes" }).success,
    ).toBe(false);
    expect(
      CreatorActionRecordSchema.safeParse({ kind: "proof_commands", require: "any", reason: "yes" })
        .success,
    ).toBe(true);
    expect(
      CreatorActionRecordSchema.safeParse({
        ...record,
        commands: [{ ...accepted, fingerprint: "xyz" }],
      }).success,
    ).toBe(false);
    expect(AcceptedProofCommandSchema.safeParse({ ...accepted, timeout: undefined }).success).toBe(
      false,
    );
  });

  it("is a medium risk when it lets the engine run programs, a low one when it only sets a demand", () => {
    expect(proofCommandsRisk({ commands: [accepted] })).toBe("medium");
    expect(proofCommandsRisk({})).toBe("low");
    expect(proofCommandsRisk({ commands: [] })).toBe("low");
  });
});

describe("the proof the engine produced", () => {
  const run = {
    command: "tests",
    fingerprint: "b".repeat(24),
    ended: "exit",
    exit: 0,
    ms: 1200,
    commit: "c".repeat(40),
    clean: true,
    summary: "12 passed",
  };
  const proof = {
    requirement: "ENF-2",
    kind: "test",
    result: "pass",
    source: "engine:tests",
    entry: "d".repeat(12),
  };

  it("carries its origin and its run; a proof an agent reported carries neither", () => {
    expect(RequirementProvedPayloadSchema.safeParse(proof).success).toBe(true);
    expect(
      RequirementProvedPayloadSchema.safeParse({ ...proof, origin: "engine", run }).success,
    ).toBe(true);
    expect(
      RequirementProvedPayloadSchema.safeParse({ ...proof, origin: "reported", run }).success,
    ).toBe(false);
  });

  it("bounds a run: a code or not (stopped), a duration, a summary", () => {
    expect(ProofRunSchema.safeParse({ ...run, ended: "timeout", exit: null }).success).toBe(true);
    for (const refused of [
      { ...run, ended: "killed" },
      { ...run, ms: -1 },
      { ...run, summary: "" },
      { ...run, summary: "x".repeat(701) },
      { ...run, fingerprint: "short" },
      { ...run, command: "Not A Name" },
      { ...run, extra: 1 },
    ]) {
      expect(ProofRunSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false);
    }
  });
});
