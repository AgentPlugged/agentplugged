import { describe, expect, it } from "vitest";
import {
  CreatorActionRecordSchema,
  CreatorActionSchema,
  FORGE_CREATOR_ACTIONS,
} from "./creator-action.js";
import { ArchitectureHeaderSchema } from "./document-header.js";
import { ErrorCode } from "./error-payload.js";
import { eventTypeUpgrade, KNOWN_EVENT_TYPES } from "./event-types.js";
import {
  DependenciesSchema,
  INSTALL_EVENT_TYPES,
  InstallRecordedPayloadSchema,
  PackageNameSchema,
} from "./install.js";
import { InstallSettingsSchema, MethodConfigSchema } from "./method-config.js";
import {
  AnswerStackInputSchema,
  AskStackInputSchema,
  MAX_STACK_ITEMS,
  OpenStackInputSchema,
  STACK_EVENT_TYPES,
  StackAnsweredPayloadSchema,
  StackIdInputSchema,
  StackOpenedPayloadSchema,
  stackIdOf,
} from "./stack.js";

const DIGEST = "a".repeat(64);
const item = (n: number) => ({ n, checkpoint: `G-AAAAAAAAA${n}`, digest: DIGEST });

describe("the stack to validate", () => {
  it("names a stack P- then ten characters of the event that opened it", () => {
    expect(stackIdOf("01JZ8Q3N4V7M2K9QX4TB")).toBe("P-7M2K9QX4TB");
    expect(StackIdInputSchema.parse(" p-7m2k9qx4tb ")).toBe("P-7M2K9QX4TB");
    expect(StackIdInputSchema.safeParse("S-7M2K9QX4TB").success).toBe(false);
    expect(StackIdInputSchema.safeParse("P-7M2K9QX4T").success).toBe(false);
  });

  it("opens with numbered, distinct points, 2 to 16", () => {
    expect(StackOpenedPayloadSchema.safeParse({ items: [item(1), item(2)] }).success).toBe(true);
    const full = Array.from({ length: MAX_STACK_ITEMS }, (_, i) => ({
      n: i + 1,
      checkpoint: `G-AAAAAAAAA${"0123456789ABCDEF"[i]}`,
      digest: DIGEST,
    }));
    expect(StackOpenedPayloadSchema.safeParse({ items: full }).success).toBe(true);
    expect(StackOpenedPayloadSchema.safeParse({ items: [item(1)] }).success).toBe(false);
    const tooMany = [...full, item(MAX_STACK_ITEMS + 1)];
    expect(StackOpenedPayloadSchema.safeParse({ items: tooMany }).success).toBe(false);
    // Numbers 1, 2, 3… without a gap, in order; a point once.
    expect(StackOpenedPayloadSchema.safeParse({ items: [item(1), item(3)] }).success).toBe(false);
    expect(StackOpenedPayloadSchema.safeParse({ items: [item(2), item(1)] }).success).toBe(false);
    expect(
      StackOpenedPayloadSchema.safeParse({ items: [item(1), { ...item(1), n: 2 }] }).success,
    ).toBe(false);
    expect(
      StackOpenedPayloadSchema.safeParse({ items: [item(1), { ...item(2), extra: 1 }] }).success,
    ).toBe(false);
  });

  it("takes from the agent only what the engine does not read: the stack, never a number or a decision", () => {
    expect(AskStackInputSchema.parse({ agent: "iris", stack: "p-7m2k9qx4tb" })).toEqual({
      agent: "iris",
      stack: "P-7M2K9QX4TB",
    });
    for (const extra of [{ approve: [1] }, { decision: "approved" }, { channel: "x" }]) {
      expect(
        AskStackInputSchema.safeParse({ agent: "iris", stack: "P-7M2K9QX4TB", ...extra }).success,
      ).toBe(false);
      expect(
        AnswerStackInputSchema.safeParse({
          agent: "iris",
          stack: "P-7M2K9QX4TB",
          quote: "j'approuve tout",
          ...extra,
        }).success,
      ).toBe(false);
    }
    expect(
      AnswerStackInputSchema.safeParse({
        agent: "iris",
        stack: "P-7M2K9QX4TB",
        quote: "j'approuve tout",
        session: "abc-123",
      }).success,
    ).toBe(true);
    expect(
      AnswerStackInputSchema.safeParse({ agent: "iris", stack: "P-7M2K9QX4TB", quote: "  " })
        .success,
    ).toBe(false);
    expect(
      OpenStackInputSchema.parse({ agent: "iris", checkpoints: ["g-aaaaaaaaaa", "G-BBBBBBBBBB"] })
        .checkpoints,
    ).toEqual(["G-AAAAAAAAAA", "G-BBBBBBBBBB"]);
  });

  it("records an answer from the chat with its quote, or from the form with its channel", () => {
    const chat = {
      stack: "P-7M2K9QX4TB",
      source: "chat",
      approve: [1, 2, 4],
      quote: "j'approuve 1, 2 et 4",
      proof: { message: { digest: DIGEST, at: "2026-10-04T12:00:00.000Z" } },
    };
    expect(StackAnsweredPayloadSchema.safeParse(chat).success).toBe(true);
    expect(StackAnsweredPayloadSchema.safeParse({ ...chat, proof: undefined }).success).toBe(true);
    const form = {
      stack: "P-7M2K9QX4TB",
      source: "elicitation",
      approve: [1, 3],
      channel: "claude-code",
      form: DIGEST,
    };
    expect(StackAnsweredPayloadSchema.safeParse(form).success).toBe(true);
    // A quote goes with the chat only, and a channel with the form only.
    expect(StackAnsweredPayloadSchema.safeParse({ ...form, quote: "ok" }).success).toBe(false);
    expect(StackAnsweredPayloadSchema.safeParse({ ...chat, channel: "x" }).success).toBe(false);
    expect(StackAnsweredPayloadSchema.safeParse({ ...chat, quote: undefined }).success).toBe(false);
    // The numbers approved: some, strictly increasing, from 1 to 16.
    for (const approve of [[], [2, 1], [1, 1], [0], [17]]) {
      expect(
        StackAnsweredPayloadSchema.safeParse({ ...form, approve }).success,
        String(approve),
      ).toBe(false);
    }
  });

  it("is two new types that an older engine asks to upgrade for, and four new error codes", () => {
    for (const type of [STACK_EVENT_TYPES.opened, STACK_EVENT_TYPES.answered]) {
      expect(KNOWN_EVENT_TYPES).toContain(type);
      expect(eventTypeUpgrade(type, 1)).toBeUndefined();
      // `stack.answered` is at version 2 (the question tool); `stack.opened` at 1.
      expect(eventTypeUpgrade(type, type === STACK_EVENT_TYPES.answered ? 3 : 2)?.code).toBe(
        ErrorCode.UPGRADE_REQUIRED,
      );
    }
    expect(KNOWN_EVENT_TYPES).toContain(INSTALL_EVENT_TYPES.recorded);
    for (const code of [
      "STACK_INVALID",
      "STACK_NOT_FOUND",
      "STACK_CLOSED",
      "STACK_REPLY_UNCLEAR",
      "FORGE_GESTURE_FAILED",
    ]) {
      expect(Object.keys(ErrorCode)).toContain(code);
    }
  });
});

describe("the gestures of the forge", () => {
  it("are three actions, none irreversible, with only what the creator may say", () => {
    expect([...FORGE_CREATOR_ACTIONS].sort()).toEqual([
      "forge_merge_ci",
      "forge_push_main",
      "forge_repo_create",
      "release",
    ]);
    expect(
      CreatorActionSchema.safeParse({ kind: "forge_repo_create", forge: "github", name: "shop" })
        .success,
    ).toBe(true);
    expect(CreatorActionSchema.safeParse({ kind: "forge_push_main" }).success).toBe(true);
    expect(
      CreatorActionSchema.safeParse({ kind: "forge_merge_ci", branch: "ci/base-workflows" })
        .success,
    ).toBe(true);
  });

  it("never take the commit, the target or the main branch from the agent", () => {
    expect(
      CreatorActionSchema.safeParse({ kind: "forge_push_main", commit: "a".repeat(40) }).success,
    ).toBe(false);
    expect(
      CreatorActionSchema.safeParse({ kind: "forge_push_main", target: "github.com/a/b" }).success,
    ).toBe(false);
    expect(
      CreatorActionSchema.safeParse({
        kind: "forge_merge_ci",
        branch: "ci/x",
        commit: "a".repeat(40),
      }).success,
    ).toBe(false);
    // The record carries them, set by the engine, with the reason.
    const push = {
      kind: "forge_push_main",
      branch: "main",
      commit: "a".repeat(40),
      target: "github.com/ada/shop",
      reason: "the first push",
    };
    expect(CreatorActionRecordSchema.safeParse(push).success).toBe(true);
    expect(CreatorActionRecordSchema.safeParse({ ...push, commit: undefined }).success).toBe(false);
    expect(CreatorActionRecordSchema.safeParse({ ...push, target: "evil" }).success).toBe(false);
  });

  it("checks the names: a repository, an owner, the branch of the CI, never an option or a path", () => {
    const create = (extra: Record<string, unknown>) =>
      CreatorActionSchema.safeParse({
        kind: "forge_repo_create",
        forge: "github",
        name: "shop",
        ...extra,
      }).success;
    expect(create({})).toBe(true);
    expect(create({ owner: "acme", visibility: "public" })).toBe(true);
    expect(create({ owner: "team/sub" })).toBe(true);
    for (const name of ["", "-rf", "a b", "a/b", "x.git", "$(id)", "a".repeat(101)]) {
      expect(create({ name }), name).toBe(false);
    }
    for (const owner of ["", "-x", "a b", "../x", "a//b"])
      expect(create({ owner }), owner).toBe(false);
    expect(create({ forge: "bitbucket" })).toBe(false);
    expect(create({ visibility: "internal" })).toBe(false);
    for (const branch of [
      "main",
      "ci",
      "ci/",
      "ci/../x",
      "ci/a b",
      "feat/x",
      "ci/-x",
      "ci/$(id)",
    ]) {
      expect(
        CreatorActionSchema.safeParse({ kind: "forge_merge_ci", branch }).success,
        branch,
      ).toBe(false);
    }
  });

  it("lets the profile action set the installs mode, alone or with the rest", () => {
    expect(CreatorActionSchema.safeParse({ kind: "profile", installs: "visible" }).success).toBe(
      true,
    );
    expect(CreatorActionSchema.safeParse({ kind: "profile", installs: "always" }).success).toBe(
      false,
    );
    expect(CreatorActionSchema.safeParse({ kind: "profile" }).success).toBe(false);
  });
});

describe("the installs the architecture plans", () => {
  it("is a setting of method.yaml: visible or validate, nothing else", () => {
    expect(InstallSettingsSchema.safeParse({ mode: "visible" }).success).toBe(true);
    expect(InstallSettingsSchema.safeParse({}).success).toBe(true);
    expect(InstallSettingsSchema.safeParse({ mode: "fast" }).success).toBe(false);
    expect(InstallSettingsSchema.safeParse({ mode: "visible", extra: 1 }).success).toBe(false);
    expect(
      MethodConfigSchema.safeParse({
        format_version: 2,
        engine_version: "1.0.0",
        installs: { mode: "visible" },
      }).success,
    ).toBe(true);
  });

  it("is declared in the architecture's header, by ecosystem, names without versions", () => {
    expect(DependenciesSchema.safeParse({ npm: ["react", "@supabase/supabase-js"] }).success).toBe(
      true,
    );
    expect(
      DependenciesSchema.safeParse({
        pypi: ["Django"],
        go: ["github.com/spf13/cobra"],
        packagist: ["symfony/console"],
      }).success,
    ).toBe(true);
    expect(DependenciesSchema.safeParse({ cobol: ["x"] }).success).toBe(false);
    expect(DependenciesSchema.safeParse({ npm: "react" }).success).toBe(false);
    for (const name of ["react@19", "react 19", "", "a;b", "$(id)", "@scope", "-x", "a'b"]) {
      expect(PackageNameSchema.safeParse(name).success, name).toBe(false);
    }
    const header = (dependencies: unknown) =>
      ArchitectureHeaderSchema.safeParse({
        id: "architecture",
        kind: "architecture",
        owner: "alex",
        links: [],
        dependencies,
      }).success;
    expect(header({ npm: ["react"] })).toBe(true);
    expect(header(undefined)).toBe(true);
    expect(header({ npm: ["react@19"] })).toBe(false);
    expect(header("react")).toBe(false);
  });

  it("is recorded in the activity with the ecosystem, the manager and the packages", () => {
    const payload = {
      ecosystem: "npm",
      manager: "pnpm",
      packages: ["react"],
      manifest: false,
      via: "hook",
    };
    expect(InstallRecordedPayloadSchema.safeParse(payload).success).toBe(true);
    expect(
      InstallRecordedPayloadSchema.safeParse({ ...payload, packages: [], manifest: true }).success,
    ).toBe(true);
    expect(InstallRecordedPayloadSchema.safeParse({ ...payload, via: "terminal" }).success).toBe(
      false,
    );
    expect(InstallRecordedPayloadSchema.safeParse({ ...payload, ecosystem: "cobol" }).success).toBe(
      false,
    );
    expect(InstallRecordedPayloadSchema.safeParse({ ...payload, manager: "NPM; rm" }).success).toBe(
      false,
    );
  });
});
