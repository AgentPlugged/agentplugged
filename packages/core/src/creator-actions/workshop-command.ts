import {
  AgentIdSchema,
  CreatorActionSchema,
  ErrorCode,
  isSkillOverrideContent,
  plainLine,
  SkillNameSchema,
  type SkillOverride,
} from "@agentplugged/protocol";
import { z } from "zod";
import { invalidInput } from "../agent-activity/agent-commands.js";
import { knownIds, workshopKnown } from "../agents/agent-command.js";
import { loadOverrides } from "../agents/overrides.js";
import {
  checkSkillOverrideRequest,
  loadSkillLayers,
  type OverrideCost,
  overrideCostWithFiles,
} from "../agents/skill-overrides.js";
import {
  analyze,
  bodySize,
  type Check,
  type Finding,
  type Origin,
  type Subject,
  verify,
} from "../agents/workshop-analysis.js";
import { buildFromContent, definitionDir } from "../agents/workshop-build.js";
import { type Cost, costOf, type Draft } from "../agents/workshop-rules.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { type EvalStatus, evalStatus, loadSkill } from "../evals/eval-store.js";
import { definitionFolders } from "../method/definitions.js";
import { contentProblem, dryRunFileAction } from "./creator-action-files.js";
import { contentRequestProblem, invalidAction } from "./request-command.js";

/**
 * The workshop of agents and skills, one action of the `agent` tool: `agent.workshop`.
 * It writes nothing and asks nothing of the creator; it tells an agent, before it opens a request
 * or after it, what the engine finds:
 * - `check`: the `agent_create` or `agent_edit` it is about to request, tried on the product's
 *   files exactly as the request and the terminal's command try it (same checks, same refusals,
 *   everything wrong listed at once), with what the addition costs;
 * - `analyze`: an agent or a skill that exists, the method's or the creator's: what can be clearer,
 *   lighter or easier to trigger, each finding with the one gesture that settles it;
 * - `verify`: the small suite of verifications of an agent or a skill (valid, says when it is
 *   called, sections, links, safe, within the ceilings).
 */

const Workshop = z.looseObject({
  op: z.enum(["check", "analyze", "verify"]),
  /** `analyze` and `verify`: the agent or skill. */
  id: SkillNameSchema.optional(),
  /** `check`: the `agent_create` or `agent_edit` action, as `guard.creator_action` takes it. */
  action: z.looseObject({ kind: z.string() }).optional(),
  /** `verify`: phrases the creator would say; each one must find an answer in the thing. */
  triggers: z.array(plainLine(200)).max(8).optional(),
});

export const WorkshopInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64).optional(),
  workshop: Workshop,
});

export type WorkshopResult =
  | {
      readonly op: "check";
      readonly ok: true;
      /** The files the request would write. */
      readonly paths: readonly string[];
      readonly cost?: Cost;
      /** A customisation of a shipped skill: what it adds each time the skill runs. */
      readonly customisation?: OverrideCost;
    }
  | {
      readonly op: "analyze";
      readonly id: string;
      readonly kind: "agent" | "skill";
      readonly origin: Origin;
      readonly cost: Cost;
      readonly findings: readonly Finding[];
    }
  | {
      readonly op: "verify";
      readonly id: string;
      readonly kind: "agent" | "skill";
      readonly origin: Origin;
      readonly ok: boolean;
      readonly passed: number;
      readonly failed: readonly Check[];
      /** A skill of the creator's: its behaviour cases and the pass kept. */
      readonly evals?: EvalStatus;
    };

function notFound(id: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.AGENT_NOT_FOUND, "error.agent_not_found", { id });
}

function refused(field: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "workshop",
    field,
    reason: `workshop: ${field}: ${reason}`,
  });
}

/** `check`: the request tried on the product's files. */
async function check(
  context: CommandContext,
  action: Readonly<Record<string, unknown>>,
): Promise<WorkshopResult | AgentPluggedError> {
  if (action.kind !== "agent_create" && action.kind !== "agent_edit") {
    return refused("action.kind", "expected agent_create or agent_edit");
  }
  if (action.content !== undefined) {
    const problem = contentRequestProblem(action);
    if (problem !== undefined) return problem;
  }
  const parsed = CreatorActionSchema.safeParse(action);
  if (!parsed.success) return invalidAction(parsed.error);
  const record = { ...parsed.data, reason: "workshop check" } as Parameters<
    typeof contentProblem
  >[0];
  const missing = contentProblem(record);
  if (missing !== undefined) return missing;
  const outcome = await dryRunFileAction(context, record);
  if (outcome instanceof AgentPluggedError) return outcome;
  let cost: Cost | undefined;
  if (record.kind === "agent_create" && record.content !== undefined) {
    const draft: Draft = {
      kind: record.definition === "skill" ? "skill" : "agent",
      id: record.id,
      name: record.name,
      title: record.title,
      description: record.description,
      domain: record.domain,
      phase: record.phase,
      icon: record.icon,
      role: record.role,
      content: record.content,
    };
    const built = buildFromContent(definitionDir(draft.kind, record.id), draft);
    if (!(built.definition instanceof AgentPluggedError)) {
      cost = costOf(record.id, record.description, bodySize(built.definition));
    }
  }
  // A customisation of a shipped skill costs nothing at every request, and this much
  // each time the skill runs (both layers together).
  let customisation: OverrideCost | undefined;
  if (
    record.kind === "agent_edit" &&
    record.content !== undefined &&
    isSkillOverrideContent(record.content)
  ) {
    const checked = await checkSkillOverrideRequest(
      context.files,
      record.id,
      record.layer ?? "shared",
      record.content as SkillOverride,
    );
    if (!(checked instanceof AgentPluggedError))
      customisation = await overrideCostWithFiles(context.files, record.id, checked.layers);
  }
  return {
    op: "check",
    ok: true,
    paths: outcome.paths,
    ...(cost === undefined ? {} : { cost }),
    ...(customisation === undefined ? {} : { customisation }),
  };
}

/** The agent or skill `id` as the product holds it, with what judging it needs. */
async function subjectOf(
  context: CommandContext,
  id: string,
): Promise<Subject | AgentPluggedError> {
  const workshop = await workshopKnown(context);
  if (workshop instanceof AgentPluggedError) return workshop;
  const definition = workshop.definitions.find((candidate) => candidate.name === id);
  if (definition === undefined) return notFound(id);
  const ids = await knownIds(context.files, context.method);
  const origin: Origin = ids.shipped.get(id) === definition.kind ? "shipped" : "creator";
  let override: Subject["override"];
  if (origin === "shipped" && definition.kind === "agent") {
    const shipped = await definitionFolders(context.method, "agents");
    const overrides = await loadOverrides(context.files, workshop.definitions, shipped);
    if (overrides instanceof AgentPluggedError) return overrides;
    override = overrides.get(id);
  }
  return {
    definition,
    origin,
    override,
    all: workshop.definitions,
    skills: workshop.known.skills,
  };
}

/** The files a persistent fact (`file:<path>`) names that the product does not hold. */
async function missingFacts(context: CommandContext, subject: Subject): Promise<string[]> {
  const facts = [
    ...(subject.definition.agent?.persistent_facts ?? []),
    ...(subject.override?.persistent_facts ?? []),
  ];
  const missing: string[] = [];
  for (const fact of facts) {
    if (!fact.startsWith("file:")) continue;
    const path = fact.slice("file:".length).trim();
    if (!(await context.files.exists(path))) missing.push(path);
  }
  return missing;
}

export const workshopCommand = defineCommand<WorkshopResult>({
  name: "workshop",
  audience: "agent",
  description:
    "Workshop of agents and skills (skill workshop, Lou), a read: it writes nothing. `workshop` with `op`. `check` with `action` (the `agent_create` or `agent_edit` with `content` you are about to request): the engine tries it exactly as the request would and lists everything wrong at once (a name taken by an agent, a skill or a display name; a missing field; a description over 180 characters or that does not say when it is called; an instruction that goes round a rule, the creator's word, a secret or the main branch; a menu skill or a `references/` file that does not exist; a body over the ceiling), or answers `ok` with the files it would write and `cost` (what the addition adds to every request: name and description, and what it weighs when it runs). `analyze` with `id` (an agent or skill, the method's or the creator's): `findings`, `fix` before `tip`, each with its `gesture`: `agent_edit` (the creator's own: request it with the corrected `content`), `override` (a shipped agent: the creator's customisation file, never the method's) or `copy` (a shipped skill: its own text is never edited; `agent_edit` with `content` customises it, or a copy of their own). `verify` with `id` and optionally `triggers` (phrases the creator would say): the small suite of checks, `ok`, `passed` and the `failed` ones. The creator's word decides every change: you propose one finding at a time and request it with `guard.creator_action`.",
  inputSchema: WorkshopInputSchema,
  async run(context, input) {
    const parsed = WorkshopInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("workshop", parsed.error));
    const { op, id, action, triggers } = parsed.data.workshop;
    try {
      if (op === "check") {
        if (action === undefined) return fail(refused("workshop.action", "give the action"));
        const result = await check(context, action);
        return result instanceof AgentPluggedError ? fail(result) : ok(result);
      }
      if (id === undefined) return fail(refused("workshop.id", "give the agent or skill"));
      const subject = await subjectOf(context, id);
      if (subject instanceof AgentPluggedError) return fail(subject);
      const { definition, origin } = subject;
      if (op === "analyze") {
        const description = (definition.frontmatter as { description: string }).description;
        return ok({
          op,
          id,
          kind: definition.kind,
          origin,
          cost: costOf(id, description, bodySize(definition)),
          findings: analyze(subject),
        });
      }
      const checks = verify(subject, triggers ?? [], await missingFacts(context, subject));
      // A skill of the creator's carries its behaviour cases: valid, and the pass kept.
      let evals: EvalStatus | undefined;
      if (definition.kind === "skill" && origin === "creator") {
        const loaded = await loadSkill(context.files, definition.dir);
        if (!("error" in loaded)) {
          const others = subject.all
            .filter((other) => other.kind === "skill")
            .map((other) => ({
              name: other.name,
              description: (other.frontmatter as { description: string }).description,
            }));
          evals = evalStatus(loaded, others, triggers ?? []);
          // A pass kept for another version of the skill or of its cases is not a proof any more:
          // the evaluation has to run again, and a regression blocks there.
          const outdated =
            evals.reference === "stale"
              ? [
                  `the pass kept is out of date: run \`agentplugged eval run ${id}\` (a regression blocks there)`,
                ]
              : evals.reference === "invalid"
                ? ["the pass kept cannot be read: record it again"]
                : [];
          const wrong = [...evals.problems, ...outdated];
          checks.push({
            check: "evals",
            ok: wrong.length === 0,
            ...(wrong.length === 0 ? {} : { detail: wrong.join("; ") }),
          });
        }
      }
      // The customisation of a shipped skill, as `sync` reads it.
      if (definition.kind === "skill" && origin === "shipped") {
        const layers = await loadSkillLayers(context.files, id);
        if (layers instanceof AgentPluggedError) {
          checks.push({
            check: "customisation",
            ok: false,
            detail: String(layers.details.problems ?? layers.details.reason ?? layers.code),
          });
        } else if (layers.shared !== undefined || layers.personal !== undefined) {
          checks.push({ check: "customisation", ok: true });
        }
      }
      const failed = checks.filter((entry) => !entry.ok);
      return ok({
        op,
        id,
        kind: definition.kind,
        origin,
        ok: failed.length === 0,
        passed: checks.length - failed.length,
        failed,
        ...(evals === undefined ? {} : { evals }),
      });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});
