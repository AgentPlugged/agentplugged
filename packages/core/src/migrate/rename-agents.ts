import { ErrorCode, MAX_PARALLEL_STORIES } from "@agentplugged/protocol";
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";
import { RENAMED_AGENTS, RETIRED_DEVELOPERS } from "../agents/agent-aliases.js";
import { AGENT_OVERRIDES_DIR, overridePath } from "../agents/overrides.js";
import { AgentPluggedError } from "../errors.js";
import { normalizeText } from "../init/generated.js";
import { METHOD_DIR } from "../init/layout.js";
import { stringifyMethodDocument } from "../init/method-config.js";
import { SKILL_FILE } from "../method/definitions.js";
import { planShippedCopy } from "../method/install-method.js";
import type { MethodSource } from "../method/method-source.js";
import { inactiveAgents } from "../profile/catalog.js";
import type { WorkspaceFiles } from "../workspace-files.js";

/**
 * The format step `rename-agents`: format 1 → 2. The team is renamed, the
 * developers are chosen by specialty instead of counted, and the quick-lane developer is gone.
 * With the alias table (`agents/agent-aliases.ts`), the one place of the product that names the
 * former agents.
 */

/** Identifier of the step, recorded by `method.migrated` (`steps`). Never changed once shipped. */
export const RENAME_AGENTS_STEP = "rename-agents";

/** The developers of format 1 and their successor: the backend specialty takes them over. */
const DEVELOPER_SUCCESSORS: Readonly<Record<string, string>> = { nova: "sam", orion: "ethan" };

/** The backend developers, in the order the quick-lane developer's settings go to the first free. */
const BACKEND = ["sam", "ethan"] as const;

/** An additional developer of format 1 (`nova-2`, `orion-3`): it had no folder of its own. */
const DERIVED_DEVELOPER = /^(nova|orion)-[1-9]\d*$/;

/** What the step did that the creator should know, for the summary of `migrate`. */
export type MigrationNote =
  | {
      /** `profile.developers` became specialties and, from 1 on, a ceiling. */
      readonly kind: "specialties";
      readonly developers: number;
      readonly specialties: readonly string[];
      readonly max_parallel_stories: number | null;
    }
  | {
      /** A setting or customisation of a former agent now belongs to `to`. */
      readonly kind: "setting_moved" | "override_moved";
      readonly from: string;
      readonly to: string;
    }
  | {
      /** A setting, or an entry of `agents.enabled` or `agents.disabled`, with no successor. */
      readonly kind: "setting_dropped" | "list_dropped";
      readonly from: string;
    }
  | {
      /** A customisation with no successor, kept aside where `sync` does not read it. */
      readonly kind: "override_retired";
      readonly from: string;
      readonly path: string;
    };

/** A former identifier in an id list of `method.yaml` (`agents.enabled`, `agents.disabled`). */
function successor(id: string): string | undefined {
  if (Object.hasOwn(RENAMED_AGENTS, id)) return RENAMED_AGENTS[id];
  if (Object.hasOwn(DEVELOPER_SUCCESSORS, id)) return DEVELOPER_SUCCESSORS[id];
  if (RETIRED_DEVELOPERS.includes(id) || DERIVED_DEVELOPER.test(id)) return undefined;
  return id;
}

/**
 * Where the settings or customisations of the former agents go: renamed agents to their
 * successor, `nova` to `sam`, `orion` to `ethan`, `rex` (the quick lane) to the first backend
 * developer still free; the additional developers (`nova-2`…) and what finds no free place go
 * nowhere. `ids` are the former identifiers that carry something.
 */
function destinations(ids: readonly string[]): Map<string, string | undefined> {
  const result = new Map<string, string | undefined>();
  for (const id of ids) if (id !== "rex") result.set(id, successor(id));
  if (ids.includes("rex")) {
    const taken = new Set(result.values());
    result.set(
      "rex",
      BACKEND.find((id) => !taken.has(id)),
    );
  }
  return result;
}

function stringItems(node: unknown): string[] | undefined {
  if (!isSeq(node)) return undefined;
  return node.items.map((item) => (isScalar(item) ? String(item.value) : String(item)));
}

/**
 * The text of `method.yaml` at format 2, and what changed. Comments are kept. `developers: 0`
 * becomes no specialty; `developers: N` (N ≥ 1) the `backend` and `frontend` specialties and a
 * ceiling of N stories at once; `agents.inactive` is computed again from the new profile; the
 * ids of `agents.enabled`, `agents.disabled` and `agents.settings` are renamed.
 */
export function renameAgentsText(text: string): { text: string; notes: MigrationNote[] } {
  const document = parseDocument(text);
  const notes: MigrationNote[] = [];

  const profile = document.get("profile", true);
  let newProfile: Parameters<typeof inactiveAgents>[0] | undefined;
  if (isMap(profile) && profile.has("developers")) {
    const raw = (profile as YAMLMap).get("developers");
    // Format 1 counted 0 to 5 developers: anything else is reported on the field it was.
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      throw new Error("profile.developers must be a whole number from 0");
    }
    const developers = raw;
    const specialties = developers > 0 ? ["backend", "frontend"] : [];
    const ceiling = developers > 0 ? Math.min(developers, MAX_PARALLEL_STORIES) : null;
    profile.delete("developers");
    profile.set("specialties", document.createNode(specialties));
    if (ceiling !== null) profile.set("max_parallel_stories", ceiling);
    notes.push({ kind: "specialties", developers, specialties, max_parallel_stories: ceiling });
  }
  if (isMap(profile)) {
    const value = profile.toJSON() as Record<string, unknown>;
    if (Array.isArray(value.domains) && Array.isArray(value.specialties)) {
      newProfile = value as unknown as Parameters<typeof inactiveAgents>[0];
    }
  }

  const agents = document.get("agents", true);
  if (isMap(agents)) {
    for (const list of ["enabled", "disabled"] as const) {
      const items = stringItems(agents.get(list, true));
      if (items === undefined) continue;
      const renamed: string[] = [];
      for (const id of items) {
        const next = successor(id);
        if (next === undefined) notes.push({ kind: "list_dropped", from: id });
        else if (!renamed.includes(next)) renamed.push(next);
      }
      agents.set(list, document.createNode(renamed));
    }
    // An id enabled and disabled at once after renaming: the creator's disabling wins.
    const enabled = stringItems(agents.get("enabled", true));
    const disabled = stringItems(agents.get("disabled", true));
    if (enabled !== undefined && disabled !== undefined) {
      agents.set("enabled", document.createNode(enabled.filter((id) => !disabled.includes(id))));
    }
    const settings = agents.get("settings", true);
    if (isMap(settings)) {
      const keys = settings.items.map((pair) => String(isScalar(pair.key) ? pair.key.value : ""));
      const former = keys.filter((id) => successor(id) !== id || id === "rex");
      const moves = destinations(former);
      const kept = new Set(keys.filter((id) => !former.includes(id)));
      for (const pair of settings.items) {
        const id = String(isScalar(pair.key) ? pair.key.value : "");
        if (!moves.has(id)) continue;
        const to = moves.get(id);
        if (to === undefined || kept.has(to)) {
          notes.push({ kind: "setting_dropped", from: id });
          pair.key = null;
          continue;
        }
        kept.add(to);
        pair.key = document.createNode(to);
        notes.push({ kind: "setting_moved", from: id, to });
      }
      settings.items = settings.items.filter((pair) => pair.key !== null);
    }
    if (newProfile !== undefined) {
      agents.set("inactive", document.createNode(inactiveAgents(newProfile)));
    } else {
      const inactive = stringItems(agents.get("inactive", true));
      if (inactive !== undefined) {
        const renamed = [...new Set(inactive.flatMap((id) => successor(id) ?? []))].sort();
        agents.set("inactive", document.createNode(renamed));
      }
    }
  } else if (newProfile !== undefined) {
    document.setIn(["agents", "inactive"], document.createNode(inactiveAgents(newProfile)));
  }
  return { text: stringifyMethodDocument(document, text), notes };
}

/** A file the step writes, or removes, outside `method.yaml`. */
export interface MigrationFileOperation {
  readonly path: string;
  readonly action: "write" | "remove";
  readonly content?: string | Uint8Array;
}

export interface MigrationFilePlan {
  readonly operations: readonly MigrationFileOperation[];
  readonly notes: readonly MigrationNote[];
}

/** Where a customisation without successor is kept: a sub-folder `sync` does not read. */
export const RETIRED_OVERRIDES_DIR = `${AGENT_OVERRIDES_DIR}/retired`;

/**
 * The agents and skills format 2 ships that format 1 did not: an agent or a skill of the
 * creator's with one of these names would take the place of the method's.
 */
const NEW_NAMES = [
  "maya",
  "stella",
  "alex",
  "izzy",
  "quentin",
  "chloe",
  "omar",
  "zoe",
  "julien",
  "lou",
  "ethan",
  "hugo",
  "lina",
  "jade",
];

function conflict(id: string, path: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.AGENT_ID_CONFLICT, "error.agent_id_conflict", {
    id,
    path,
  });
}

/**
 * The files of `.agentplugged/` the step changes, planned from the working copy, nothing written:
 * - an agent or a skill of the creator's whose name the method now ships stops everything
 *   (`AGENT_ID_CONFLICT`, naming it): a folder that holds exactly the shipped `SKILL.md` is the
 *   method's own (a run of `migrate` interrupted after its files);
 * - the shipped copies of the former agents leave `.agentplugged/agents/`, and the method is
 *   copied again (the renamed team, the new developers, the quick-lane skill);
 * - `overrides/agents/<former>.yaml` moves to its successor's name; one without successor goes to
 *   `overrides/agents/retired/`, which `sync` does not read.
 */
export async function planRenameAgentsFiles(
  files: WorkspaceFiles,
  method: MethodSource,
): Promise<MigrationFilePlan | AgentPluggedError> {
  // The shipped `SKILL.md` of `<dir>/<name>`, normalised, or undefined when the method has none.
  const shippedText = async (dir: string, name: string): Promise<string | undefined> => {
    const path = `${dir}/${name}/${SKILL_FILE}`;
    if (!(await method.listFiles(`${dir}/${name}`)).includes(path)) return undefined;
    return normalizeText(await method.readText(path));
  };
  for (const name of [...NEW_NAMES, "quick-lane"]) {
    for (const dir of ["agents", "skills"] as const) {
      const folder = `${METHOD_DIR}/${dir}/${name}`;
      if ((await files.listFiles(folder)).length === 0) continue;
      // The method's own copy, left by a run of `migrate` stopped after its files: kept.
      const path = `${folder}/${SKILL_FILE}`;
      const shipped = await shippedText(dir, name);
      const own = (await files.exists(path)) ? normalizeText(await files.readText(path)) : null;
      if (shipped === undefined || own !== shipped) return conflict(name, `${folder}/`);
    }
  }

  const writes = new Map<string, string | Uint8Array>();
  const copies = await planShippedCopy(method, files);
  if (copies instanceof AgentPluggedError) return copies;
  for (const copy of copies) for (const write of copy.writes) writes.set(write.path, write.content);

  // The former agents' folders: every file the new method does not write again goes.
  const shippedPaths = new Set<string>();
  for (const copy of copies) {
    const folder = copy.path.replace(/\/$/, "");
    for (const path of await method.listFiles(folder.slice(METHOD_DIR.length + 1))) {
      shippedPaths.add(`${METHOD_DIR}/${path}`);
    }
  }
  const removes = new Set<string>();
  for (const former of [...Object.keys(RENAMED_AGENTS), ...RETIRED_DEVELOPERS]) {
    for (const path of await files.listFiles(`${METHOD_DIR}/agents/${former}`)) {
      if (!shippedPaths.has(path) && !writes.has(path)) removes.add(path);
    }
  }

  // The customisations of the former agents.
  const notes: MigrationNote[] = [];
  const overrides = (await files.listFiles(AGENT_OVERRIDES_DIR))
    .map((path) => path.slice(AGENT_OVERRIDES_DIR.length + 1))
    .filter((name) => !name.includes("/") && name.endsWith(".yaml"))
    .map((name) => name.slice(0, -".yaml".length));
  // `izzy.yaml` names no agent at format 1: present, it is the scrum master's customisation that
  // a run stopped before its end already moved, and `sam.yaml` is no longer the scrum master's.
  const samMoved = overrides.includes("izzy");
  const readOverride = (id: string) => files.readText(overridePath(id));
  // `sam.yaml` still holding the scrum master's text, already copied to `izzy.yaml`.
  const samLeftover =
    samMoved &&
    overrides.includes("sam") &&
    (await readOverride("sam")) === (await readOverride("izzy"));
  const former = overrides.filter(
    (id) => (successor(id) !== id || id === "rex") && !(id === "sam" && samMoved),
  );
  const moves = destinations(former);
  const targets = new Map<string, string>();
  for (const id of former) {
    const to = moves.get(id);
    const source = overridePath(id);
    const content = await files.readText(source);
    if (to !== undefined && !targets.has(to)) {
      targets.set(to, id);
      const free = !overrides.includes(to) || former.includes(to) || (to === "sam" && samLeftover);
      if (free) writes.set(overridePath(to), content);
      // Already there with the same content: written by a run stopped before its removals.
      // Anything else under a new name is the creator's own.
      else if ((await readOverride(to)) !== content) return conflict(to, overridePath(to));
      notes.push({ kind: "override_moved", from: id, to });
    } else {
      // Kept aside under a free name: a file already there is never replaced by another one.
      let path = `${RETIRED_OVERRIDES_DIR}/${id}.yaml`;
      for (let n = 2; (await files.exists(path)) && (await files.readText(path)) !== content; n++) {
        path = `${RETIRED_OVERRIDES_DIR}/${id}-${n}.yaml`;
      }
      writes.set(path, content);
      notes.push({ kind: "override_retired", from: id, path });
    }
  }
  for (const id of former) {
    const source = overridePath(id);
    if (!writes.has(source)) removes.add(source);
  }
  // A run stopped before its removals left the former scrum master's file next to its copy.
  if (samLeftover && !writes.has(overridePath("sam"))) removes.add(overridePath("sam"));

  // The customisations first, in order (`izzy.yaml` before `sam.yaml`), then the method's copy,
  // then the removals: a run stopped anywhere can run again (`samMoved`, `samLeftover`).
  const byPath = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);
  const entries = [...writes.entries()];
  const isOverride = (path: string) => path.startsWith(`${AGENT_OVERRIDES_DIR}/`);
  const operations: MigrationFileOperation[] = [
    ...entries
      .filter(([path]) => isOverride(path))
      .sort(byPath)
      .map(([path, content]) => ({ path, action: "write" as const, content })),
    ...entries
      .filter(([path]) => !isOverride(path))
      .sort(byPath)
      .map(([path, content]) => ({ path, action: "write" as const, content })),
    ...[...removes].sort().map((path) => ({ path, action: "remove" as const })),
  ];
  return { operations, notes };
}
