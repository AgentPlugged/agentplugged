import { ErrorCode } from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { normalizeText } from "../init/generated.js";
import { METHOD_DIR } from "../init/layout.js";
import { sameBytes } from "../values.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import {
  AGENT_FILE,
  checkMenuSkills,
  type Definition,
  type DefinitionKind,
  isMarkdown,
  readDefinitions,
  SKILL_FILE,
} from "./definitions.js";
import type { MethodSource } from "./method-source.js";

/** Folders of definitions, in the shipped method and under `.agentplugged/`. */
export const DEFINITION_DIRS: ReadonlyArray<readonly [string, DefinitionKind]> = [
  ["agents", "agent"],
  ["skills", "skill"],
];

export interface FileWrite {
  readonly path: string;
  readonly content: string | Uint8Array;
}

/** One shipped agent or skill: its folder under `.agentplugged/`, and what has to be written. */
export interface ShippedCopy {
  readonly path: string;
  readonly action: "created" | "updated" | "unchanged";
  readonly writes: readonly FileWrite[];
}

/**
 * Plans the copy of the shipped method into `.agentplugged/agents/` and `.agentplugged/skills/`.
 * A shipped definition already present is refreshed file by file when it differs; folders that
 * match no shipped definition (the creator's own) are never touched. Markdown is compared after
 * normalisation, so a CRLF checkout is not a change.
 */
export async function planShippedCopy(
  method: MethodSource,
  files: WorkspaceFiles,
): Promise<ShippedCopy[] | AgentPluggedError> {
  const loaded: Array<readonly [string, Definition[]]> = [];
  for (const [dir, kind] of DEFINITION_DIRS) {
    const definitions = await readDefinitions(method, dir, kind);
    if (definitions instanceof AgentPluggedError) return definitions;
    loaded.push([dir, definitions]);
  }
  const unknownSkill = checkMenuSkills(loaded.flatMap(([, definitions]) => definitions));
  if (unknownSkill !== undefined) return unknownSkill;
  // A folder of the creator's of the other kind under a shipped name (a skill `noah` when the
  // method now ships the agent Noah) would make every later command fail: refused
  // before anything is written, the creator renames it.
  for (const [dir, definitions] of loaded) {
    const other = DEFINITION_DIRS.find(([name]) => name !== dir)?.[0];
    if (other === undefined) continue;
    for (const definition of definitions) {
      const path = `${METHOD_DIR}/${other}/${definition.name}`;
      if ((await files.listFiles(path)).length === 0) continue;
      return new AgentPluggedError(ErrorCode.AGENT_ID_CONFLICT, "error.agent_id_conflict.shipped", {
        id: definition.name,
        path: `${path}/`,
      });
    }
  }

  const copies: ShippedCopy[] = [];
  for (const [dir, definitions] of loaded) {
    for (const definition of definitions) {
      const target = `${METHOD_DIR}/${dir}/${definition.name}`;
      const existed = await files.exists(target);
      const writes: FileWrite[] = [];
      const own = definition.agentText === undefined ? [SKILL_FILE] : [SKILL_FILE, AGENT_FILE];
      for (const file of [...own, ...definition.annexes]) {
        const source = `${definition.dir}/${file}`;
        const path = `${target}/${file}`;
        const present = existed && (await files.exists(path));
        if (isMarkdown(file) || file === AGENT_FILE) {
          const content =
            file === SKILL_FILE
              ? definition.text
              : file === AGENT_FILE
                ? (definition.agentText ?? "")
                : normalizeText(await method.readText(source));
          if (!present || normalizeText(await files.readText(path)) !== content) {
            writes.push({ path, content });
          }
        } else {
          const content = await method.readBytes(source);
          if (!present || !sameBytes(await files.readBytes(path), content)) {
            writes.push({ path, content });
          }
        }
      }
      const action = !existed ? "created" : writes.length > 0 ? "updated" : "unchanged";
      copies.push({ path: `${target}/`, action, writes });
    }
  }
  return copies;
}
