import {
  type GitWorkflow,
  type InstallMode,
  METHOD_FORMAT_VERSION,
  NOAH_AGENT,
  type PermissionMode,
  type ProductOrigin,
  type Profile,
  TOOL_IDS,
  type ToolId,
  type ValidationMode,
  type ValidationPoint,
} from "@agentplugged/protocol";
import { defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { validateGitWorkflow, writeGitWorkflow } from "../git/git-workflow.js";
import { recordGitWorkflow, type WorkflowRecorded } from "../git/record-workflow.js";
import { type InitHumanKey, installHumanKey } from "../human/human-commands.js";
import { type InitProductKey, installProductKey } from "../human/product-key-commands.js";
import { productIdMismatch } from "../journal/prepare-event.js";
import { readJournalProductId, writeProductId } from "../journal/product-id.js";
import { newUlid } from "../journal/ulid.js";
import { definitionFolders } from "../method/definitions.js";
import { planShippedCopy } from "../method/install-method.js";
import {
  effectiveTable,
  inheritClients,
  parseModelTable,
  readShippedTable,
  renderModelsFile,
} from "../models/model-table.js";
import {
  validateInstallMode,
  validatePermissionMode,
  validatePoints,
  validateProfile,
  validateValidationMode,
  writeInstallMode,
  writePermissionMode,
  writePoints,
  writeProfile,
  writeValidationMode,
} from "../profile/profile.js";
import { PROFILE_PATH, renderProfile } from "../project-profile/profile-file.js";
import { scanProject } from "../project-profile/scan.js";
import { resolveRules } from "../rules/resolve-rules.js";
import { fallbacksFor } from "../sync/compatibility.js";
import { engineCommand, mcpLaunch, withEngineCommand } from "../sync/mcp.js";
import { type DetectedTool, detectTools } from "../tools/detect-tools.js";
import { toolsFromDetection } from "../tools/targeted-tools.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import {
  constitutionTarget,
  renderConstitution,
  renderConstitutionReferenceFiles,
} from "./constitution.js";
import { detectExistingProduct, knowledgeBaseExpected } from "./existing-product.js";
import {
  GENERATED_HEADER,
  GENERATED_HEADER_HASH,
  isGenerated,
  normalizeText,
  pointerStyleOf,
  withPointerBlock,
} from "./generated.js";
import {
  METHOD_CONFIG_PATH,
  METHOD_CONSTITUTION_PATH,
  METHOD_DIR,
  METHOD_GITIGNORE_PATH,
  METHOD_SUBDIRS,
  MODELS_PATH,
  POINTER_FILES,
  ROOT_CONSTITUTION_PATH,
} from "./layout.js";
import {
  type LoadedMethodConfig,
  loadMethodConfig,
  methodConfigInvalid,
  renderMethodConfig,
  writeEngineVersion,
  writeTools,
} from "./method-config.js";

/** The tool that reads each pointer file. */
const POINTER_TOOLS: Readonly<Record<(typeof POINTER_FILES)[number], ToolId>> = {
  "CLAUDE.md": "claude-code",
  "GEMINI.md": "antigravity",
};

export type InitAction = "created" | "updated" | "unchanged";

/** One managed element of the summary. Folders end with `/`. */
export interface InitEntry {
  readonly path: string;
  readonly action: InitAction;
}

export interface InitResult {
  readonly entries: readonly InitEntry[];
  /** AI tools found on the machine; the method is installed whatever they are. */
  readonly tools: readonly DetectedTool[];
  /** Profile recorded in `method.yaml` after the run; undefined when none was given or found. */
  readonly profile: Profile | undefined;
  /**
   * The validation level recorded in `method.yaml` after the run; undefined when
   * none was given or found (`chat` then applies).
   */
  readonly validation?: ValidationMode;
  /**
   * The installs mode recorded in `method.yaml` after the run; undefined when none
   * was given or found (`validate` then applies).
   */
  readonly installs?: InstallMode;
  /**
   * The points the creator keeps for themselves, recorded in `method.yaml` after the run (story
   * 3.29); undefined when none were given or found (every point then waits for them).
   */
  readonly points?: readonly ValidationPoint[];
  /**
   * The Git workflow recorded in `method.yaml` after the run; undefined when none was
   * given or found (the recommendation then applies, and Noah offers the choice once).
   */
  readonly workflow?: GitWorkflow;
  /** What recording a workflow chosen now did in the journal. */
  readonly workflow_recorded?: WorkflowRecorded;
  /**
   * What the AI tool asks before it acts, recorded in `method.yaml` after the run;
   * undefined when none was given or found (`protected` then applies).
   */
  readonly permissions?: PermissionMode;
  /** Tools `sync` will generate files for (the `tools` list of `method.yaml`). */
  readonly targetedTools: readonly ToolId[];
  /** `--upgrade-engine` replaced the pinned engine version: from which one, to which one. */
  readonly engineUpgrade: { readonly from: string; readonly to: string } | undefined;
  /** `--upgrade-engine` without `method.yaml`: nothing was pinned yet, the new file pins it. */
  readonly nothingPinned: boolean;
  /** An existing `method.yaml` had no `product_id`: init added this one. */
  readonly productIdAdded: string | undefined;
  /**
   * The creator's key: created on the first install on this machine, published in
   * the journal when there is a Git repository. Undefined when the surface gives no keychain.
   */
  readonly humanKey?: InitHumanKey;
  /**
   * The product key: created on the product's first init and announced in the
   * journal, or to import when the journal names one this machine does not hold. Undefined when
   * the surface gives no keychain.
   */
  readonly productKey?: InitProductKey;
  /**
   * `existing` when this run created `method.yaml` in a folder that already held the product
   *, and wrote it as its `origin`. Undefined otherwise.
   */
  readonly origin?: ProductOrigin;
  /**
   * True when, on that existing product, `next` will call Zoé for the knowledge base first: the
   * `docs` domain on and Zoé active. Undefined otherwise.
   */
  readonly knowledgeBase?: true;
}

type Operation =
  | { readonly kind: "mkdir"; readonly path: string }
  | { readonly kind: "write"; readonly path: string; readonly content: string | Uint8Array };

/**
 * Everything is decided first, then written: validation happens before any write. An I/O
 * failure while applying the plan is not rolled back.
 */
class Plan {
  readonly entries: InitEntry[] = [];
  readonly operations: Operation[] = [];

  add(path: string, action: InitAction, ...operations: Operation[]): void {
    this.entries.push({ path, action });
    this.operations.push(...operations);
  }

  async apply(files: WorkspaceFiles): Promise<void> {
    for (const operation of this.operations) {
      if (operation.kind === "mkdir") await files.mkdir(operation.path);
      else if (typeof operation.content === "string") {
        await files.writeText(operation.path, operation.content);
      } else await files.writeBytes(operation.path, operation.content);
    }
  }
}

/** A file owned by agentplugged: created, refreshed, or left alone when it belongs to the creator. */
async function planGeneratedFile(
  plan: Plan,
  files: WorkspaceFiles,
  path: string,
  content: string,
  header: string,
): Promise<void> {
  if (!(await files.exists(path))) {
    plan.add(path, "created", { kind: "write", path, content });
    return;
  }
  const current = await files.readText(path);
  if (!isGenerated(current, header) || normalizeText(current) === content) {
    plan.add(path, "unchanged");
    return;
  }
  plan.add(path, "updated", { kind: "write", path, content });
}

/**
 * A creator's instruction file gets the pointer block once, at the end, and the block is kept
 * pointing to the constitution (an `@` import in `CLAUDE.md`). The file is never created.
 */
async function planPointer(
  plan: Plan,
  files: WorkspaceFiles,
  path: string,
  target: string,
  current?: string,
): Promise<void> {
  const content = current ?? ((await files.exists(path)) ? await files.readText(path) : undefined);
  if (content === undefined) return;
  if (isGenerated(content)) {
    plan.add(path, "unchanged");
    return;
  }
  // The constitution may have moved: only the block's content is refreshed.
  const updated = withPointerBlock(content, target, pointerStyleOf(path));
  if (updated === undefined) plan.add(path, "unchanged");
  else plan.add(path, "updated", { kind: "write", path, content: updated });
}

/** A choice the creator gave, once validated; undefined when they gave none. */
function choice<T>(
  value: unknown,
  validate: (value: unknown) => T | AgentPluggedError,
): T | AgentPluggedError | undefined {
  return value === undefined ? undefined : validate(value);
}

export const initCommand = defineCommand<InitResult>({
  name: "init",
  upgradesEngine: (input) => input.upgrade_engine === true,
  /**
   * `input.profile`: the profile chosen by the creator, written only when none is recorded.
   * `input.upgrade_engine`: pin the running engine version in an existing `method.yaml`.
   */
  async run(context, input) {
    const { files, tools, method, engineVersion, newId = newUlid, journal } = context;
    // The creator's settings and the chosen profile are validated before anything is written.
    const chosen = choice(input.profile, validateProfile);
    if (chosen instanceof AgentPluggedError) return fail(chosen);
    // The validation level the creator chose, written only when none is recorded.
    const chosenMode = choice(input.validation, validateValidationMode);
    if (chosenMode instanceof AgentPluggedError) return fail(chosenMode);
    // The installs mode the creator chose, written only when none is recorded.
    const chosenInstalls = choice(input.installs, validateInstallMode);
    if (chosenInstalls instanceof AgentPluggedError) return fail(chosenInstalls);
    // The points the creator keeps, written only when none are recorded.
    const chosenPoints = choice(input.points, validatePoints);
    if (chosenPoints instanceof AgentPluggedError) return fail(chosenPoints);
    // The Git workflow the creator chose, written only when none is recorded.
    const chosenWorkflow = choice(input.workflow, validateGitWorkflow);
    if (chosenWorkflow instanceof AgentPluggedError) return fail(chosenWorkflow);
    // What the AI tool asks before it acts, written only when none is recorded.
    const chosenPermissions = choice(input.permissions, validatePermissionMode);
    if (chosenPermissions instanceof AgentPluggedError) return fail(chosenPermissions);
    // The AI tools the creator chose, written when `method.yaml` is created.
    let chosenTools: ToolId[] | undefined;
    if (input.tools !== undefined) {
      const known: readonly string[] = TOOL_IDS;
      const list = input.tools;
      if (
        !Array.isArray(list) ||
        list.length === 0 ||
        list.some((tool) => typeof tool !== "string" || !known.includes(tool)) ||
        new Set(list).size !== list.length
      ) {
        return fail(
          methodConfigInvalid(
            "tools",
            `expected at least one of ${TOOL_IDS.join(", ")}, each once`,
          ),
        );
      }
      chosenTools = TOOL_IDS.filter((id) => list.includes(id));
    }
    let loaded: LoadedMethodConfig | undefined;
    if (await files.exists(METHOD_CONFIG_PATH)) {
      const result = await loadMethodConfig(files);
      if (result instanceof AgentPluggedError) return fail(result);
      loaded = result;
    }

    // The shipped agents are validated before anything is written, too.
    const shipped = await planShippedCopy(method, files);
    if (shipped instanceof AgentPluggedError) return fail(shipped);
    // So is the model table. A copy the creator took (header removed) is kept, and used.
    const shippedModels = await readShippedTable(method);
    if (shippedModels instanceof AgentPluggedError) return fail(shippedModels);
    let table = shippedModels.table;
    if (await files.exists(MODELS_PATH)) {
      const current = await files.readText(MODELS_PATH);
      if (!isGenerated(current, GENERATED_HEADER_HASH)) {
        const own = parseModelTable(MODELS_PATH, current);
        if (own instanceof AgentPluggedError) return fail(own);
        table = own;
      }
    }

    // Detected first: a new `method.yaml` lists the tools found (all of them when none is).
    const detected = await detectTools(tools);
    const targeted = loaded?.config.tools ?? chosenTools ?? toolsFromDetection(detected);

    // A product that existed before the method: looked at before anything is written.
    const origin: ProductOrigin | undefined =
      loaded === undefined && (await detectExistingProduct(files)) ? "existing" : undefined;

    const plan = new Plan();

    const rootExists = await files.exists(METHOD_DIR);
    if (rootExists) plan.add(`${METHOD_DIR}/`, "unchanged");
    else plan.add(`${METHOD_DIR}/`, "created", { kind: "mkdir", path: METHOD_DIR });

    for (const name of METHOD_SUBDIRS) {
      const dir = `${METHOD_DIR}/${name}`;
      const keep = `${dir}/.gitkeep`;
      const dirExists = rootExists && (await files.exists(dir));
      const keepExists = dirExists && (await files.exists(keep));
      const operations: Operation[] = [];
      if (!dirExists) operations.push({ kind: "mkdir", path: dir });
      if (!keepExists) operations.push({ kind: "write", path: keep, content: "" });
      const action: InitAction = !dirExists ? "created" : !keepExists ? "updated" : "unchanged";
      plan.add(`${dir}/`, action, ...operations);
    }

    await planGeneratedFile(
      plan,
      files,
      METHOD_GITIGNORE_PATH,
      `${GENERATED_HEADER_HASH}\n.cache/\noverrides/skills/*.local.yaml\n`,
      GENERATED_HEADER_HASH,
    );

    // The project profile: written once from the product's own files; afterwards `docs profile
    // refresh` rewrites it and keeps what people declared in it.
    if (await files.exists(PROFILE_PATH)) plan.add(PROFILE_PATH, "unchanged");
    else {
      const content = renderProfile(await scanProject(files), {
        sources: [],
        acceptance: "",
        notes: "",
      });
      plan.add(PROFILE_PATH, "created", { kind: "write", path: PROFILE_PATH, content });
    }

    for (const copy of shipped) {
      const writes = copy.writes.map((write): Operation => ({ kind: "write", ...write }));
      plan.add(copy.path, copy.action, ...writes);
    }

    await planGeneratedFile(
      plan,
      files,
      MODELS_PATH,
      renderModelsFile(shippedModels.text),
      GENERATED_HEADER_HASH,
    );

    // A recorded profile is never changed by init: `profile` is the command for that.
    let profile = loaded?.config.profile;
    const addProfile = chosen !== undefined && profile === undefined;
    // Nor a recorded validation level: `profile` changes it.
    const recordedMode = loaded?.config.validation?.mode;
    const addMode = chosenMode !== undefined && recordedMode === undefined;
    // Nor a recorded installs mode: `profile` changes it.
    const recordedInstalls = loaded?.config.installs?.mode;
    const addInstalls = chosenInstalls !== undefined && recordedInstalls === undefined;
    // Nor recorded points: `profile` changes them.
    const recordedPoints = loaded?.config.validation?.points;
    const addPoints = chosenPoints !== undefined && recordedPoints === undefined;
    // Nor a recorded permission mode: `profile` changes it.
    const recordedPermissions = loaded?.config.permissions?.mode;
    const addPermissions = chosenPermissions !== undefined && recordedPermissions === undefined;
    // Nor a recorded Git workflow: `profile` changes it.
    const recordedWorkflow = loaded?.config.git;
    const addWorkflow = chosenWorkflow !== undefined && recordedWorkflow === undefined;
    // `--upgrade-engine` pins the running engine; otherwise the pinned version is never touched.
    const pinned = loaded?.config.engine_version;
    const engineUpgrade =
      input.upgrade_engine === true && pinned !== undefined && pinned !== engineVersion
        ? { from: pinned, to: engineVersion }
        : undefined;
    // `product_id` is created with the file, and added to a file from before the journal. The
    // journal is the authority: its id is adopted, and a different recorded one is refused.
    const held = await readJournalProductId(journal);
    const recorded = loaded?.config.product_id;
    if (recorded !== undefined && held !== null && recorded !== held) {
      return fail(productIdMismatch(recorded, held));
    }
    const productId = recorded === undefined ? (held ?? newId()) : undefined;
    if (
      loaded &&
      !addProfile &&
      !addMode &&
      !addPoints &&
      !addPermissions &&
      !addWorkflow &&
      engineUpgrade === undefined &&
      productId === undefined
    ) {
      plan.add(METHOD_CONFIG_PATH, "unchanged");
    } else {
      let base =
        loaded?.text ??
        renderMethodConfig({
          format_version: METHOD_FORMAT_VERSION,
          engine_version: engineVersion,
          ...(productId === undefined ? {} : { product_id: productId }),
          ...(origin === undefined ? {} : { origin }),
        });
      if (loaded && productId !== undefined) {
        const withId = writeProductId(base, productId);
        if (withId instanceof AgentPluggedError) return fail(withId);
        base = withId;
      }
      if (engineUpgrade !== undefined) {
        const upgraded = writeEngineVersion(base, engineUpgrade.to);
        if (upgraded instanceof AgentPluggedError) return fail(upgraded);
        base = upgraded;
      }
      const withProfile = addProfile && chosen !== undefined ? writeProfile(base, chosen) : base;
      if (withProfile instanceof AgentPluggedError) return fail(withProfile);
      const profiled =
        addMode && chosenMode !== undefined
          ? writeValidationMode(withProfile, chosenMode)
          : withProfile;
      if (profiled instanceof AgentPluggedError) return fail(profiled);
      const withInstalls =
        addInstalls && chosenInstalls !== undefined
          ? writeInstallMode(profiled, chosenInstalls)
          : profiled;
      if (withInstalls instanceof AgentPluggedError) return fail(withInstalls);
      const withPoints =
        addPoints && chosenPoints !== undefined
          ? writePoints(withInstalls, chosenPoints)
          : withInstalls;
      if (withPoints instanceof AgentPluggedError) return fail(withPoints);
      const withPermissions =
        addPermissions && chosenPermissions !== undefined
          ? writePermissionMode(withPoints, chosenPermissions)
          : withPoints;
      if (withPermissions instanceof AgentPluggedError) return fail(withPermissions);
      const withWorkflow =
        addWorkflow && chosenWorkflow !== undefined
          ? writeGitWorkflow(withPermissions, chosenWorkflow)
          : withPermissions;
      if (withWorkflow instanceof AgentPluggedError) return fail(withWorkflow);
      // `tools` is written when the file is created; afterwards it is the creator's to change.
      const content = loaded ? withWorkflow : writeTools(withWorkflow, targeted);
      if (content instanceof AgentPluggedError) return fail(content);
      if (addProfile) profile = chosen;
      const action: InitAction = loaded ? "updated" : "created";
      plan.add(METHOD_CONFIG_PATH, action, { kind: "write", path: METHOD_CONFIG_PATH, content });
    }

    // Constitution: at the root, unless the root AGENTS.md belongs to the creator.
    const models = effectiveTable(table, loaded?.config.models);
    // The working copy's rules, locks applied: `sync` then reads them from the main branch.
    const rules =
      loaded === undefined ? undefined : (await resolveRules(loaded.config, undefined)).rules;
    // Noah's section: the method ships him, and the creator did not disable him.
    const noah =
      (await definitionFolders(method, "agents")).has(NOAH_AGENT) &&
      !(loaded?.config.agents?.disabled ?? []).includes(NOAH_AGENT);
    // The engine's command as `sync` writes it: the same launcher as the tools' MCP
    // configuration, so `init` and `sync` never disagree on the constitution.
    const engine = engineCommand(
      mcpLaunch(engineUpgrade?.to ?? pinned ?? engineVersion, {
        ...(loaded?.config.mcp === undefined ? {} : { override: loaded.config.mcp }),
      }),
    );
    const constitution = withEngineCommand(
      renderConstitution(
        fallbacksFor(targeted, { modelInherit: inheritClients(models) }),
        rules,
        noah ? { tools: TOOL_IDS.filter((id) => targeted.includes(id)) } : undefined,
      ),
      engine,
    );
    const reference = renderConstitutionReferenceFiles(
      fallbacksFor(targeted, { modelInherit: inheritClients(models) }),
      rules,
      noah ? { tools: TOOL_IDS.filter((id) => targeted.includes(id)) } : undefined,
    ).map((file) => ({ path: file.path, content: withEngineCommand(file.content, engine) }));
    const { target, rootAgents } = await constitutionTarget(files);
    if (target === METHOD_CONSTITUTION_PATH) {
      await planPointer(plan, files, ROOT_CONSTITUTION_PATH, target, rootAgents);
    }
    await planGeneratedFile(plan, files, target, constitution, GENERATED_HEADER);
    for (const file of reference) {
      await planGeneratedFile(plan, files, file.path, file.content, GENERATED_HEADER);
    }
    // CLAUDE.md and GEMINI.md point to the constitution only while their tool is targeted.
    for (const path of POINTER_FILES) {
      if (targeted.includes(POINTER_TOOLS[path])) await planPointer(plan, files, path, target);
    }

    await plan.apply(files);
    const finalProductId = recorded ?? productId ?? held;
    const humanKey =
      finalProductId === undefined || finalProductId === null
        ? undefined
        : await installHumanKey(context, finalProductId);
    // The product key: created on the product's first init, announced in its journal.
    const productKey =
      finalProductId === undefined || finalProductId === null
        ? undefined
        : await installProductKey(context, finalProductId);
    // The workflow chosen now is recorded in the journal, where the engine reads it. A
    // folder without Git has no journal yet: `method.yaml` holds it, and `profile` records it later.
    let workflowRecorded: WorkflowRecorded | undefined;
    if (addWorkflow && chosenWorkflow !== undefined) {
      const written = await recordGitWorkflow(
        context,
        { workflow: chosenWorkflow, previous: undefined },
        "init",
      ).catch(() => undefined);
      workflowRecorded = written instanceof AgentPluggedError ? undefined : written;
    }
    const targetedTools = TOOL_IDS.filter((id) => targeted.includes(id));
    const nothingPinned = input.upgrade_engine === true && loaded === undefined;
    return ok({
      entries: plan.entries,
      tools: detected,
      profile,
      targetedTools,
      engineUpgrade,
      nothingPinned,
      productIdAdded: loaded === undefined ? undefined : productId,
      ...((addMode ? chosenMode : recordedMode) === undefined
        ? {}
        : { validation: (addMode ? chosenMode : recordedMode) as ValidationMode }),
      ...((addInstalls ? chosenInstalls : recordedInstalls) === undefined
        ? {}
        : { installs: (addInstalls ? chosenInstalls : recordedInstalls) as InstallMode }),
      ...((addPoints ? chosenPoints : recordedPoints) === undefined
        ? {}
        : { points: (addPoints ? chosenPoints : recordedPoints) as ValidationPoint[] }),
      ...((addPermissions ? chosenPermissions : recordedPermissions) === undefined
        ? {}
        : {
            permissions: (addPermissions
              ? chosenPermissions
              : recordedPermissions) as PermissionMode,
          }),
      ...((addWorkflow ? chosenWorkflow : recordedWorkflow) === undefined
        ? {}
        : { workflow: (addWorkflow ? chosenWorkflow : recordedWorkflow) as GitWorkflow }),
      ...(workflowRecorded === undefined ? {} : { workflow_recorded: workflowRecorded }),
      ...(humanKey === undefined ? {} : { humanKey }),
      ...(productKey === undefined ? {} : { productKey }),
      ...(origin === undefined ? {} : { origin }),
      ...(origin !== undefined &&
      knowledgeBaseExpected({
        format_version: METHOD_FORMAT_VERSION,
        engine_version: engineVersion,
        origin,
        ...(profile === undefined ? {} : { profile }),
      })
        ? { knowledgeBase: true as const }
        : {}),
    });
  },
});
