import { METHOD_FORMAT_VERSION, type MethodConfig } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { initCommand, resolveProfile, type ToolProbe } from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import {
  detectExistingProduct,
  isExistingProduct,
  knowledgeBaseExpected,
} from "./existing-product.js";
import { parseMethodConfig } from "./method-config.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

function config(extra: Partial<MethodConfig> = {}): MethodConfig {
  return { format_version: METHOD_FORMAT_VERSION, engine_version: "1.0.0", ...extra };
}

describe("detectExistingProduct", () => {
  it("sees nothing in an empty folder, nor in what Git, the method, the tools or an editor bring", async () => {
    expect(await detectExistingProduct(new MemoryFiles())).toBe(false);
    const fresh = new MemoryFiles({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".agentplugged/method.yaml": "",
      "AGENTS.md": "",
      "CLAUDE.md": "",
      ".claude/settings.json": "{}",
      ".mcp.json": "{}",
      "README.md": "# Ada\n",
      LICENSE: "",
      "licence.txt": "",
      ".gitignore": "",
      ".vscode/settings.json": "{}",
      ".DS_Store": "",
      ".cursorrules": "",
      ".cursorignore": "",
      ".windsurf/rules.md": "",
      ".windsurfrules": "",
      ".aider.conf.yml": "",
      ".aiderignore": "",
      ".continue/config.json": "{}",
      ".github/workflows/ci.yml": "",
      ".gitkeep": "",
      ".vs/settings.json": "{}",
      ".fleet/settings.json": "{}",
      ".zed/settings.json": "{}",
      ".devcontainer/devcontainer.json": "{}",
    });
    expect(await detectExistingProduct(fresh)).toBe(false);
  });

  it("sees the product in any other entry at the root", async () => {
    for (const path of [
      "package.json",
      "src/main.py",
      "Makefile",
      "docs/guide.md",
      "readme-old/x",
    ]) {
      expect(await detectExistingProduct(new MemoryFiles({ [path]: "" })), path).toBe(true);
    }
  });

  it("sees no product where only agentplugged was installed", async () => {
    const manifest = (value: unknown) => JSON.stringify(value);
    for (const dependencies of [
      { devDependencies: { agentplugged: "^0.1.0" } },
      { dependencies: { agentplugged: "0.1.0" } },
    ]) {
      const installed = new MemoryFiles({
        "package.json": manifest({ name: "ada", private: true, ...dependencies }),
        "package-lock.json": "{}",
        "pnpm-lock.yaml": "",
        "node_modules/agentplugged/package.json": "{}",
      });
      expect(await detectExistingProduct(installed)).toBe(false);
    }
    for (const [name, files] of [
      [
        "another dependency",
        { "package.json": manifest({ dependencies: { agentplugged: "1", react: "19" } }) },
      ],
      ["no dependency", { "package.json": manifest({ name: "ada" }) }],
      ["unreadable manifest", { "package.json": "{ not json" }],
      [
        "a file of the product",
        { "package.json": manifest({ devDependencies: { agentplugged: "1" } }), "index.js": "" },
      ],
    ] as const) {
      expect(await detectExistingProduct(new MemoryFiles(files)), name).toBe(true);
    }
  });

  it("sees nothing when the files cannot be listed or read, and never throws", async () => {
    const failing = Object.assign(new MemoryFiles({ "src/a.ts": "" }), {
      listEntries: async () => Promise.reject(new Error("EIO")),
    });
    expect(await detectExistingProduct(failing)).toBe(false);
  });

  it("sees nothing when the files cannot be listed", async () => {
    const files = new MemoryFiles({ "package.json": "{}" });
    const unlisted = Object.assign(Object.create(files) as MemoryFiles, {
      listEntries: undefined,
    });
    expect(await detectExistingProduct(unlisted)).toBe(false);
  });
});

describe("isExistingProduct", () => {
  it("follows origin, else the maintenance profile", () => {
    const maintenance = resolveProfile("maintenance");
    expect(isExistingProduct(config())).toBe(false);
    expect(isExistingProduct(config({ origin: "existing" }))).toBe(true);
    expect(isExistingProduct(config({ profile: maintenance }))).toBe(true);
    expect(isExistingProduct(config({ profile: maintenance, origin: "new" }))).toBe(false);
    expect(isExistingProduct(config({ profile: resolveProfile("new-product") }))).toBe(false);
  });
});

describe("knowledgeBaseExpected", () => {
  it("needs an existing product, the docs domain and Zoé active", () => {
    const existing = config({ origin: "existing" });
    expect(knowledgeBaseExpected(existing)).toBe(true);
    expect(knowledgeBaseExpected(config())).toBe(false);
    expect(
      knowledgeBaseExpected(config({ origin: "existing", profile: resolveProfile("prototype") })),
    ).toBe(false);
    expect(knowledgeBaseExpected({ ...existing, agents: { disabled: ["zoe"] } })).toBe(false);
    expect(knowledgeBaseExpected(config({ profile: resolveProfile("maintenance") }))).toBe(true);
  });
});

describe("init: origin", () => {
  const context = (files: MemoryFiles) => ({
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human" as const,
    engineVersion: "1.0.0",
  });

  it("writes origin: existing when it creates method.yaml next to the product's files", async () => {
    const files = new MemoryFiles({ "pyproject.toml": "[project]\n" });
    const result = await initCommand.run(context(files), {});
    expect(result.ok && result.value.origin).toBe("existing");
    expect(result.ok && result.value.knowledgeBase).toBe(true);
    const written = parseMethodConfig(files.files.get(".agentplugged/method.yaml") ?? "");
    expect(written).toMatchObject({ origin: "existing" });
  });
  it("says the knowledge base comes first only when the docs domain is on", async () => {
    const files = new MemoryFiles({ "Cargo.toml": "[package]\n" });
    const result = await initCommand.run(context(files), { profile: resolveProfile("prototype") });
    expect(result.ok && result.value.origin).toBe("existing");
    expect(result.ok && result.value.knowledgeBase).toBeUndefined();
  });

  it("writes no origin in an empty folder, and never adds nor changes it afterwards", async () => {
    const files = new MemoryFiles();
    const first = await initCommand.run(context(files), {});
    expect(first.ok && first.value.origin).toBeUndefined();
    expect(first.ok && first.value.knowledgeBase).toBeUndefined();
    files.seed("package.json", "{}");
    const again = await initCommand.run(context(files), {});
    expect(again.ok && again.value.origin).toBeUndefined();
    expect(files.files.get(".agentplugged/method.yaml")).not.toContain("origin");
  });

  it("refuses an unknown origin in method.yaml", () => {
    const text = `format_version: ${METHOD_FORMAT_VERSION}\nengine_version: 1.0.0\norigin: old\n`;
    expect(parseMethodConfig(text)).toMatchObject({ details: { field: "origin" } });
  });
});
