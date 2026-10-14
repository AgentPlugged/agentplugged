/**
 * The smaller version of a skill that a section is judged against, pure: the same
 * skill without a section of its body, or without a file of detail. If the two do the same on the
 * cases, the part is decoration and goes; if the smaller one does worse, the part earns its place.
 */

export interface StagedFile {
  /** Relative path, `/`-separated. */
  readonly path: string;
  readonly text: string;
}

const SKILL_FILE = "SKILL.md";

const normal = (value: string) =>
  value
    .toLowerCase()
    .replace(/[`*_#]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

/**
 * The skill without `part`: a file of detail named by its path (`references/judge.md`), else the
 * section of `SKILL.md` whose heading says it (the section runs to the next heading of the same
 * level or a higher one). Undefined when nothing matches: the variant would be the skill itself,
 * and a comparison of a skill with itself proves nothing.
 */
export function withoutPart(
  files: readonly StagedFile[],
  part: string,
): { readonly files: StagedFile[]; readonly removed: number } | undefined {
  const wanted = part.trim();
  const file = files.find((entry) => entry.path === wanted && entry.path !== SKILL_FILE);
  if (file !== undefined) {
    return { files: files.filter((entry) => entry !== file), removed: file.text.length };
  }
  const skill = files.find((entry) => entry.path === SKILL_FILE);
  if (skill === undefined) return undefined;
  const lines = skill.text.split("\n");
  const target = normal(wanted);
  let inFence = false;
  let start = -1;
  let level = 0;
  let end = lines.length;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/u.test(line)) inFence = !inFence;
    const heading = inFence ? undefined : /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line);
    if (heading === undefined || heading === null) continue;
    const depth = (heading[1] as string).length;
    if (start === -1) {
      if (normal(heading[2] as string) === target) {
        start = index;
        level = depth;
      }
    } else if (depth <= level) {
      end = index;
      break;
    }
  }
  if (start === -1) return undefined;
  const text = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
  return {
    files: files.map((entry) => (entry === skill ? { path: SKILL_FILE, text } : entry)),
    removed: skill.text.length - text.length,
  };
}
