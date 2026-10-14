import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Tests only. Noah's definition is small, and the detail of what he does lives in the
 * `references/` of his folder, read when the situation comes up. A test about what Noah does reads
 * all of it: his `SKILL.md`, his `agent.yaml` and his references.
 */
export function noahCorpus(methodDir: string): string {
  const dir = join(methodDir, "agents", "noah");
  const parts = [
    readFileSync(join(dir, "SKILL.md"), "utf8"),
    readFileSync(join(dir, "agent.yaml"), "utf8"),
  ];
  for (const name of readdirSync(join(dir, "references")).sort()) {
    parts.push(readFileSync(join(dir, "references", name), "utf8"));
  }
  return parts.join("\n").replace(/\r\n/g, "\n");
}

/** `read(path)` of a test, answering Noah's paths with his whole corpus. */
export function withNoah(
  methodDir: string,
  read: (path: string) => string,
  transform: (text: string) => string = (text) => text,
): (path: string) => string {
  return (path) =>
    path === "agents/noah/SKILL.md" || path === "agents/noah/agent.yaml"
      ? transform(noahCorpus(methodDir))
      : read(path);
}
