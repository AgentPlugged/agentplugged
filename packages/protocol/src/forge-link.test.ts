import { describe, expect, it } from "vitest";
import {
  baseOrderTypes,
  FORGE_DEFAULT_HOSTS,
  ForgeLinkStatusSchema,
  ForgeTargetSchema,
  forgeAccessOf,
  forgeHostOf,
  forgeReference,
  forgeSecretName,
  MachineReportSchema,
  orderTag,
  SECRET_NAME_PATTERN,
} from "./index.js";

describe("forge link", () => {
  it("names the secret of each platform, its own host included, in the shape a secret name has", () => {
    expect(forgeSecretName({ provider: "github" })).toBe("forge.github");
    expect(forgeSecretName({ provider: "gitlab", host: "gitlab.com" })).toBe("forge.gitlab");
    const own = forgeSecretName({ provider: "gitlab", host: "git.acme.io:8443" });
    expect(own).toBe("forge.gitlab.git.acme.io..8443");
    expect(SECRET_NAME_PATTERN.test(own)).toBe(true);
    expect(forgeHostOf({ provider: "github" })).toBe(FORGE_DEFAULT_HOSTS.github);
    // The longest host still gives a valid secret name and a reference the receipt can carry.
    const longest = `${"a".repeat(40)}.example.com`.slice(0, 50);
    const target = { provider: "gitlab", host: longest } as const;
    expect(ForgeTargetSchema.safeParse(target).success).toBe(true);
    expect(SECRET_NAME_PATTERN.test(forgeSecretName(target))).toBe(true);
    expect(forgeReference(target, "grant_remains").length).toBeLessThanOrEqual(128);
    expect(ForgeTargetSchema.safeParse({ ...target, host: `${longest}x` }).success).toBe(false);
  });

  it("accepts a host name and nothing that is an address", () => {
    for (const host of ["gitlab.example.com", "git.acme.io:8443", "localhost", "127.0.0.1:9000"]) {
      expect(ForgeTargetSchema.safeParse({ provider: "gitlab", host }).success).toBe(true);
    }
    for (const host of [
      "https://gitlab.example.com",
      "user@gitlab.example.com",
      "gitlab.example.com/path",
      "gitlab.example.com?x=1",
      "GitLab.Example.com",
      "gitlab.example.com:99999",
      "gitlab.example.com:0",
      "-bad.example.com",
      "",
      "a b",
    ]) {
      expect(ForgeTargetSchema.safeParse({ provider: "gitlab", host }).success, host).toBe(false);
    }
    expect(ForgeTargetSchema.safeParse({ provider: "bitbucket" }).success).toBe(false);
    expect(ForgeTargetSchema.safeParse({ provider: "github", token: "x" }).success).toBe(false);
  });

  it("declares both orders as high risk, for the machine, with nothing sealed in them", () => {
    const registry = baseOrderTypes();
    for (const type of ["forge.link", "forge.unlink"]) {
      const declaration = registry.get(orderTag(type));
      expect(declaration?.risk).toBe("high");
      expect(declaration?.target).toBe("bridge");
      expect(declaration?.sealedParams).toBeUndefined();
    }
  });

  it("holds no field that could carry a token", () => {
    const keys = Object.keys(ForgeLinkStatusSchema.shape).join(" ");
    expect(keys).not.toMatch(/token|secret|password|device_code|refresh/i);
    expect(forgeReference({ provider: "github" }, "removed")).toBe("forge:forge.github:removed");
    expect(forgeReference({ provider: "github" }, "grant_remains")).toBe(
      "forge:forge.github:grant_remains",
    );
  });

  it("is part of what a machine reports, and a strict shape", () => {
    const base = {
      name: "pc",
      bridge_version: "1.0.0",
      protocol_version: 1,
      products: [],
      agents: 0,
      tools: [],
    };
    const link = { provider: "github", host: "github.com", state: "linked", account: "ada" };
    expect(MachineReportSchema.safeParse({ ...base, forges: [link] }).success).toBe(true);
    expect(MachineReportSchema.safeParse({ ...base }).success).toBe(true);
    expect(
      MachineReportSchema.safeParse({ ...base, forges: [{ ...link, token: "ghp_x" }] }).success,
    ).toBe(false);
  });

  it("never calls a token read only unless every scope is", () => {
    expect(forgeAccessOf([])).toBe("unknown");
    expect(forgeAccessOf(["read_api"])).toBe("read");
    expect(forgeAccessOf(["read_api", "read_repository"])).toBe("read");
    expect(forgeAccessOf(["contents:read", "pull_requests:read"])).toBe("read");
    expect(forgeAccessOf(["repo"])).toBe("write");
    expect(forgeAccessOf(["api"])).toBe("write");
    expect(forgeAccessOf(["read_api", "write_repository"])).toBe("write");
    expect(forgeAccessOf(["contents:read", "pull_requests:write"])).toBe("write");
    expect(forgeAccessOf(["something_new"])).toBe("write");
  });
});
