import {
  CheckWriteInputSchema,
  ErrorCode,
  MAIN_SESSION_AGENT,
  WRITE_GUARD_EVENT_TYPES,
  WRITE_TEXT_MAX,
  type WriteDoubt,
  type WriteDoubtedPayload,
  type WriteRefusedPayload,
  type WriteRule,
} from "@agentplugged/protocol";
import { type CommandContext, defineCommand, ok } from "../command.js";
import { secretKind } from "../doctor/support-report.js";
import { AgentPluggedError } from "../errors.js";
import type { HookAnswer } from "../trust/trust-commands.js";
import { isRecord } from "../values.js";
import { decisionViolation } from "./write-decisions.js";
import {
  absolutePath,
  anyIndex,
  appendOwn,
  type GuardIndex,
  guardIndex,
  inside,
  productRootOf,
} from "./write-index.js";
import { inScope } from "./write-scope.js";
import { type TestVerdict, testVerdict } from "./write-tests.js";

/**
 * `check_write`: the hook of Claude Code before `Write`, `Edit`, `MultiEdit` and
 * `NotebookEdit`. It refuses a write that breaks a **named rule** and lets every other through:
 *
 * - `secret` (security): the text holds a key or a token of a known shape. Needs nothing from the
 *   journal, so it never waits for it. The value is never written anywhere: not in the answer, not
 *   in the journal.
 * - `test`: a write to a file of tests that isolates a test (`.only`), disables one with
 *   no reason, waits a fixed time, asserts what cannot fail, or makes the file too large. Like the
 *   secret rule it needs nothing from the journal (`write-tests.ts`).
 * - `scope`: the file is outside what the story in progress names (its text, plus what the creator
 *   added with `scope_widen`), safe exceptions apart (tests, documents, the method's folders…).
 * - `decision` (`AD-n`): the write contradicts a decision of the approved architecture that states
 *   a checkable line (`Guard: no dependency <name>`, `Guard: never import <module> from <folder>`).
 *
 * In doubt it answers nothing and traces the doubt, once per session and reason: no story in
 * progress, a path owned by none or by several stories, a story that names no file, decisions that
 * cannot be checked, an error, a delay, an input it cannot read. It never waits longer than a
 * budget (`WRITE_GUARD_BUDGET_MS`).
 */

// Core has no platform types: the two timer functions it needs are declared here.
declare function setTimeout(handler: () => void, ms: number): { unref?: () => void };
declare function clearTimeout(handle: unknown): void;

/** How long the guard waits for the journal before it lets the write through in doubt. */
export const WRITE_GUARD_BUDGET_MS = 400;

/** How long a refusal waits for its own trace in the journal: the answer does not depend on it. */
const TRACE_MS = 300;

/** The most refusals one session writes in the journal: a loop that retries a refused write adds none. */
const MAX_TRACED_REFUSALS = 50;

/** A value the hook left as it was written (`${tool_input.x}`: the tool has no such field). */
const UNFILLED = /^(?:\$\{[^}]*\}|\[object Object\](?:,\[object Object\])*)$/;

/** The path or text a hook gave, or undefined: empty, or left unfilled because the tool has no such field. */
function given(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" || UNFILLED.test(trimmed) ? undefined : value;
}

/** The characters a path must not carry into a message or the journal: controls and line separators. */
const character = String.fromCharCode;
const CONTROL = new RegExp(
  `[${character(0)}-${character(31)}${character(127)}${character(0x2028)}${character(0x2029)}]+`,
  "g",
);

/** `text` cut to `max` UTF-16 units (what the schema counts), never inside a character. */
function cut(text: string, max: number): string {
  let out = "";
  for (const character of text) {
    if (out.length + character.length > max) break;
    out += character;
  }
  return out;
}

/** A text on one line, cut, for a path shown to the agent or kept in the journal. */
function oneLine(text: string, max: number): string {
  return cut(text.replace(CONTROL, " ").trim(), max);
}

/**
 * What a write adds. `MultiEdit` gives the list of its edits, which the hook substitutes as JSON:
 * the new text of each edit is read, one after the other. Anything else is the text as it came.
 */
function writtenText(tool: string, text: string): string {
  if (tool !== "MultiEdit" || !text.trimStart().startsWith("[")) return text;
  try {
    const edits: unknown = JSON.parse(text);
    if (!Array.isArray(edits)) return text;
    return edits
      .map((edit) => (isRecord(edit) && typeof edit.new_string === "string" ? edit.new_string : ""))
      .join("\n");
  } catch {
    return text;
  }
}

function deny(reason: string): HookAnswer {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/** Waits for `work` at most `ms`; undefined when it did not finish. The work goes on. */
async function within<T>(ms: number, work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What the guard concluded, before anything is written. */
type Verdict =
  | { readonly kind: "pass" }
  | { readonly kind: "doubt"; readonly reason: WriteDoubt; readonly story?: string }
  | {
      readonly kind: "refuse";
      readonly rule: Exclude<WriteRule, "secret">;
      readonly story: string;
      readonly decision?: string;
      readonly detail?: string;
      readonly message: string;
    };

interface Request {
  readonly path: string | undefined;
  readonly text: string | undefined;
  readonly cwd: string | undefined;
  readonly session: string | undefined;
}

/** Whose file it is, and the verdict on it. Reads the journal once (kept), never writes. */
async function judge(
  context: CommandContext,
  index: GuardIndex,
  request: Request,
  root: string,
): Promise<Verdict> {
  const absolute = absolutePath(request.path as string, request.cwd, root);
  // A path that leaves its root by `..` names nothing the guard can place.
  if (absolute === undefined) return { kind: "doubt", reason: "ambiguous_story" };
  const owner = index.ownerOf(absolute);
  // Outside the product and its stories' working copies: not the guard's business.
  if (owner.kind === "outside") return { kind: "pass" };
  if (owner.kind === "none") return { kind: "doubt", reason: "no_story" };
  if (owner.kind === "ambiguous") return { kind: "doubt", reason: "ambiguous_story" };
  const relative = inside(absolute, owner.root, context.platform);
  if (relative === undefined || relative === "") {
    return { kind: "doubt", reason: "ambiguous_story", story: owner.id };
  }
  const scope = await index.scopeOf(owner.id);
  const placed = inScope(relative, scope);
  if (placed === false) {
    return {
      kind: "refuse",
      rule: "scope",
      story: owner.id,
      message: `AgentPlugged refused this write: rule scope, story ${owner.id} does not name ${oneLine(relative, 120)}. If it is needed, ask the creator to widen the scope (guard.creator_action scope_widen {story: "${owner.id}", paths: ["${oneLine(relative, 120)}"]}); otherwise leave that file alone: do not write it by another tool or command (sed -i, a redirection, Set-Content, a copy, a script), and tell the coordinator which file you need and why. Nothing was written.`,
    };
  }
  if (request.text !== undefined && index.decisions !== undefined) {
    const broken = decisionViolation(index.decisions.guards, relative, request.text);
    if (broken !== undefined) {
      return {
        kind: "refuse",
        rule: "decision",
        story: owner.id,
        decision: broken.decision,
        detail: broken.detail,
        message: `AgentPlugged refused this write: decision ${broken.decision} of the architecture forbids it (${oneLine(broken.detail, 120)}). Follow the decision, or ask the creator to change it first; do not write the file by another tool or command. Nothing was written.`,
      };
    }
  }
  if (placed === undefined) return { kind: "doubt", reason: "no_scope", story: owner.id };
  if (
    index.decisions !== undefined &&
    index.decisions.unverifiable > 0 &&
    index.decisions.guards.length === 0
  ) {
    return { kind: "doubt", reason: "unverifiable_decision", story: owner.id };
  }
  return { kind: "pass" };
}

/** What the guard already wrote in this process, by journal. */
interface Written {
  /** The doubts: once per session, reason and story. */
  readonly doubts: Set<string>;
  /** The refusals: once per session, rule and file. */
  readonly refusals: Set<string>;
  /** How many refusals each session wrote. */
  readonly counts: Map<string, number>;
}

const written = new WeakMap<object, Written>();

function writtenBy(journal: object): Written {
  const found = written.get(journal);
  if (found !== undefined) return found;
  const created: Written = { doubts: new Set(), refusals: new Set(), counts: new Map() };
  written.set(journal, created);
  return created;
}

/** The traces being written, by journal: tests wait for them (`writeGuardIdle`). */
const pending = new WeakMap<object, Set<Promise<unknown>>>();

function track(journal: object, work: Promise<unknown>): void {
  const set = pending.get(journal) ?? new Set<Promise<unknown>>();
  pending.set(journal, set);
  const done = work.catch(() => undefined).finally(() => set.delete(done));
  set.add(done);
}

/** Resolves when the traces of the guard that were started are written (or failed). */
export async function writeGuardIdle(context: CommandContext): Promise<void> {
  const set = context.journal === undefined ? undefined : pending.get(context.journal);
  while (set !== undefined && set.size > 0) await Promise.all([...set]);
}

/**
 * Traces a doubt, once per session, reason and story; never waited for, never a failure. The
 * journal is the index's, so a doubt needs the product to be readable.
 */
function traceDoubt(
  context: CommandContext,
  request: Request,
  doubt: { readonly reason: WriteDoubt; readonly story?: string | undefined },
): void {
  const journal = context.journal;
  if (journal === undefined) return;
  const seen = writtenBy(journal).doubts;
  const key = `${request.session ?? "-"}|${doubt.reason}|${doubt.story ?? "-"}`;
  if (seen.has(key)) return;
  seen.add(key);
  track(
    journal,
    (async () => {
      const index = await anyIndex(context);
      if (index instanceof AgentPluggedError) {
        seen.delete(key);
        return;
      }
      const payload: WriteDoubtedPayload = {
        reason: doubt.reason,
        ...(request.path === undefined ? {} : { path: oneLine(request.path, 300) }),
        ...(doubt.story === undefined ? {} : { story: doubt.story }),
        ...(request.session === undefined ? {} : { session: oneLine(request.session, 200) }),
      };
      await appendOwn(index.journal, {
        type: WRITE_GUARD_EVENT_TYPES.doubted,
        actor: { kind: "agent", agent: MAIN_SESSION_AGENT },
        product: index.product,
        ...(doubt.story === undefined ? {} : { story: doubt.story }),
        provenance: "trusted",
        payload: { ...payload },
      });
    })().catch(() => {
      // Allowed to try again at the next write.
      seen.delete(key);
    }),
  );
}

/**
 * Writes the refusal in the journal, once per session, rule and file, and at most
 * `MAX_TRACED_REFUSALS` per session; the story is the one that owns the path, when it is known.
 */
async function traceRefusal(
  context: CommandContext,
  request: Request,
  refusal: {
    readonly rule: WriteRule;
    readonly story?: string | undefined;
    readonly decision?: string | undefined;
    readonly detail?: string | undefined;
  },
  root: string | undefined,
): Promise<void> {
  const journal = context.journal;
  if (journal === undefined) return;
  const done = writtenBy(journal);
  const session = request.session ?? "-";
  const key = `${session}|${refusal.rule}|${request.path ?? "-"}`;
  const count = done.counts.get(session) ?? 0;
  if (done.refusals.has(key) || count >= MAX_TRACED_REFUSALS) return;
  done.refusals.add(key);
  done.counts.set(session, count + 1);
  try {
    const index = await anyIndex(context);
    if (index instanceof AgentPluggedError) throw index;
    let story = refusal.story;
    if (story === undefined && request.path !== undefined && root !== undefined) {
      const absolute = absolutePath(request.path, request.cwd, root);
      const owner = absolute === undefined ? undefined : index.ownerOf(absolute);
      if (owner?.kind === "story") story = owner.id;
    }
    const payload: WriteRefusedPayload = {
      rule: refusal.rule,
      path: oneLine(request.path ?? "(unknown)", 300) || "(unknown)",
      ...(story === undefined ? {} : { story }),
      ...(refusal.decision === undefined ? {} : { decision: refusal.decision }),
      ...(refusal.detail === undefined ? {} : { detail: oneLine(refusal.detail, 120) }),
      ...(request.session === undefined ? {} : { session: oneLine(request.session, 200) }),
    };
    await appendOwn(index.journal, {
      type: WRITE_GUARD_EVENT_TYPES.refused,
      actor: { kind: "agent", agent: MAIN_SESSION_AGENT },
      product: index.product,
      ...(story === undefined ? {} : { story }),
      provenance: "trusted",
      payload: { ...payload },
    });
  } catch (error) {
    // Allowed to try again at the next write.
    done.refusals.delete(key);
    done.counts.set(session, Math.max(0, (done.counts.get(session) ?? 1) - 1));
    throw error;
  }
}

/** The error codes that mean this folder is no AgentPlugged product: nothing to guard, nothing to trace. */
function notAProduct(error: AgentPluggedError): boolean {
  return error.code === ErrorCode.METHOD_NOT_INSTALLED;
}

const NO_REQUEST: Request = {
  path: undefined,
  text: undefined,
  cwd: undefined,
  session: undefined,
};

export const checkWriteCommand = defineCommand<HookAnswer>({
  name: "check_write",
  audience: "agent",
  description:
    "Called by Claude Code's PreToolUse hook before Write, Edit, MultiEdit and NotebookEdit; you do not need to call it. Answers nothing, or a denial that names the rule: a secret, a test that cannot fail, a file outside the story's scope, an architecture decision (AD-n) contradicted. In doubt the write goes through.",
  inputSchema: CheckWriteInputSchema,
  async run(context, input) {
    const parsed = CheckWriteInputSchema.safeParse(input);
    // An input the guard cannot read is a doubt: the write goes through, traced.
    if (!parsed.success) {
      traceDoubt(context, NO_REQUEST, { reason: "unreadable_input" });
      return ok({});
    }
    const raw = parsed.data.text?.slice(0, WRITE_TEXT_MAX);
    const text = given(raw);
    const request: Request = {
      path: given(parsed.data.path),
      text: text === undefined ? undefined : writtenText(parsed.data.tool, text),
      cwd: given(parsed.data.cwd),
      session: given(parsed.data.session),
    };
    const root = context.projectRoot ?? context.chat?.project;
    // The secret rule needs nothing but the text: it is decided before the journal is read, so a
    // slow journal never lets a secret through.
    const kind = request.text === undefined ? undefined : secretKind(request.text);
    if (kind !== undefined) {
      await within(
        TRACE_MS,
        traceRefusal(
          context,
          request,
          { rule: "secret", detail: kind },
          root === undefined ? undefined : productRootOf(root),
        ).catch(() => undefined),
      );
      return ok(
        deny(
          `AgentPlugged refused this write: rule secret (security), it contains a ${kind}. A secret never goes in the code: put it in the configuration (an environment variable or the project's secret store) and read it from there. Nothing was written.`,
        ),
      );
    }
    // The tests rule needs the path and the text only, like the secret rule: a test
    // that is isolated, disabled with no reason, a fixed wait, a tautology, or a file too large.
    if (request.path !== undefined && request.text !== undefined) {
      const verdict = await testVerdict(
        context,
        { tool: parsed.data.tool, path: request.path, text: request.text, cwd: request.cwd },
        root,
      ).catch((): TestVerdict => ({ doubt: true }));
      if (verdict.refusal !== undefined) {
        await within(
          TRACE_MS,
          traceRefusal(
            context,
            request,
            { rule: "test", detail: verdict.refusal.row },
            root === undefined ? undefined : productRootOf(root),
          ).catch(() => undefined),
        );
        return ok(deny(verdict.refusal.message));
      }
      // The rules read only part of the text (a file too hostile to read in a hook's time, an
      // error): the write goes through, and the doubt is traced.
      if (verdict.doubt === true) traceDoubt(context, request, { reason: "timeout" });
    }
    // A text longer than the bound is read up to there only: the rest is a doubt, traced.
    if (parsed.data.text !== undefined && parsed.data.text.length > WRITE_TEXT_MAX) {
      traceDoubt(context, request, { reason: "unreadable_input" });
    }
    // A text the hook could not fill in (the tool gave a list the hook did not read): the secret rule
    // saw nothing. That is a doubt, traced; the other rules go on.
    if (raw !== undefined && raw.trim() !== "" && text === undefined) {
      traceDoubt(context, request, { reason: "unreadable_input" });
    }
    if (request.path === undefined || root === undefined) {
      traceDoubt(context, request, { reason: "unreadable_input" });
      return ok({});
    }
    const budget = context.writeGuardBudgetMs ?? WRITE_GUARD_BUDGET_MS;
    // The judgement goes on after the budget (it fills what the next write reads), but its
    // verdict is then of no use: the write was let through.
    const judging = (async (): Promise<Verdict> => {
      const got = await guardIndex(context);
      // The last index read serves at once; the new one is waited for only to refuse, since an old
      // index that refuses may be a scope the creator just widened.
      const index = got.stale ?? (await got.fresh);
      if (index instanceof AgentPluggedError) {
        return notAProduct(index) ? { kind: "pass" } : { kind: "doubt", reason: "error" };
      }
      const verdict = await judge(context, index, request, root);
      if (verdict.kind !== "refuse" || index !== got.stale) return verdict;
      const fresh = await got.fresh;
      if (fresh instanceof AgentPluggedError) return { kind: "doubt", reason: "error" };
      return fresh === index ? verdict : await judge(context, fresh, request, root);
    })().catch((): Verdict => ({ kind: "doubt", reason: "error" }));
    const verdict = await within(budget, judging);
    if (verdict === undefined) {
      traceDoubt(context, request, { reason: "timeout" });
      return ok({});
    }
    if (verdict.kind === "doubt") {
      traceDoubt(context, request, verdict);
      return ok({});
    }
    if (verdict.kind === "refuse") {
      await within(
        TRACE_MS,
        traceRefusal(context, request, verdict, productRootOf(root)).catch(() => undefined),
      );
      return ok(deny(verdict.message));
    }
    return ok({});
  },
});
