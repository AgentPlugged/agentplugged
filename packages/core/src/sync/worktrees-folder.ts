/**
 * The folder where the stories' working copies sit: `<parent of the project>/<its
 * name>.worktrees`, the one the engine uses (`start_story`). Codex writes only in the project's
 * folder: `sync` lists this one in `writable_roots`. Observed on Codex 0.160.1 (2026-10-06): a
 * relative path is read from the project's folder and its `..` is dropped, so the absolute path of
 * this machine is written. Run from a working copy (`<name>.worktrees/<id>`), the folder is that
 * copy's parent. Undefined for a path with no parent.
 */
export function worktreesFolderOf(projectRoot: string): string | undefined {
  const text = projectRoot.trim().replace(/[\\/]+$/, "");
  const at = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (at <= 0) return undefined;
  const parent = text.slice(0, at);
  const name = text.slice(at + 1);
  if (name === "") return undefined;
  const parentName = parent.slice(Math.max(parent.lastIndexOf("/"), parent.lastIndexOf("\\")) + 1);
  if (parentName.endsWith(".worktrees")) return parent;
  return `${parent}${text.includes("\\") ? "\\" : "/"}${name}.worktrees`;
}
