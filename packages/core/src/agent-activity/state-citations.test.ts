import { GetStateInputSchema, STATE_OPTIONS } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, renderConstitution, TOOL_GROUPS, toolNotation } from "../index.js";
import { fullState } from "../testing/state-fixtures.js";
import type { FullStateView } from "./agent-commands.js";
import { abridgeState, STATE_LIMITS, stateDetail } from "./state-view.js";

/**
 * The skills, the agents and the constitution read `get_state`, and the abridged state
 * keeps the names of the complete one only for what it keeps: this test walks every text of the
 * method and checks that each field it cites is still in the abridged state or in the answer of an
 * option, and that each call of an option it writes is valid and finds something.
 */

// Vite's glob: every text of the method, read as is (this package has no file system types).
// @ts-expect-error `import.meta.glob` is Vite's: the types of this package do not load it.
const METHOD_FILES: Record<string, string> = import.meta.glob("../../../../method/**/*.{md,yaml}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Every text that speaks of `get_state`: the method's files and the constitution. */
function texts(): Array<{ name: string; text: string }> {
  const found = Object.entries(METHOD_FILES).map(([path, text]) => ({
    name: path.slice(path.indexOf("/method/") + "/method/".length),
    text,
  }));
  found.push({
    name: "constitution",
    text: renderConstitution([], DEFAULT_RULES, { tools: ["claude-code", "codex"] }),
  });
  return found.filter(({ text }) => text.includes("state.get"));
}

/** What the text cites in backticks, whitespace folded (a span may wrap over two lines). */
function spans(text: string): string[] {
  // Fenced code blocks out first: their backticks would shift every span after them.
  const prose = text.replace(/```[\s\S]*?```/g, " ");
  return [...prose.replace(/\s+/g, " ").matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);
}

const full: FullStateView = fullState({ checkpoints: 60, stories: 12, open: 4, rich: true });
const view = abridgeState(full, STATE_LIMITS);
const checkpointId = Object.values(full.checkpoints).find((c) => c.status !== "open")?.id as string;
const storyId = "1-1";

/** The answers an option gives, by the placeholder values the texts write (`<id>`). */
function sample(input: unknown): unknown {
  return JSON.parse(
    JSON.stringify(input)
      .replace(/"checkpoint":"<id>"/g, `"checkpoint":"${checkpointId}"`)
      .replace(/"before":"<id>"/g, `"before":"${checkpointId}"`)
      .replace(/"story":"<id>"/g, `"story":"${storyId}"`)
      .replace(/"agent":"<id>"/g, '"agent":"iris"'),
  );
}

const ROOTS: unknown[] = [view];
for (const input of [
  { checkpoint: checkpointId },
  { checkpoints: { limit: 5 } },
  { agent: "iris" },
  { story: "9-9" },
  { story: "1-1" },
  { delegations: { limit: 2 } },
]) {
  const outcome = stateDetail(full, input);
  if (outcome === undefined || !outcome.found)
    throw new Error(`no detail for ${JSON.stringify(input)}`);
  ROOTS.push(outcome.value);
}

/** Does `path` lead somewhere in `value`? `<…>`, `*` and numbers stand for any key or index. */
function resolves(path: readonly string[], value: unknown): boolean {
  const [head, ...rest] = path;
  if (head === undefined) return true;
  if (Array.isArray(value)) return value.some((item) => resolves(path, item));
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const keys = /^<.*>$|^\*$|^\d+$/.test(head)
    ? Object.keys(record)
    : Object.hasOwn(record, head)
      ? [head]
      : [];
  return keys.some((key) => resolves(rest, record[key]));
}

/** The keys that open a path in the state: the fields of the complete state, and the options' own. */
const ROOT_KEYS = new Set([
  ...Object.keys(full),
  // The answers of the options.
  "checkpoint",
  "state",
]);

/** Dotted names that are not fields of the state, though they start like one. */
const NOT_FIELDS = new Set([
  // The settings of `method.yaml`.
  "agents.settings",
  // Block actions and event types.
  "story.review",
  "story.complete",
  "checkpoint.opened",
  "checkpoint.answered",
  "checkpoint.resolved",
  // The grouped tools of the MCP server: `story.progress`, `checkpoint.open`…
  ...Object.entries(TOOL_GROUPS).flatMap(([tool, group]) =>
    Object.keys(group.actions).map((action) => toolNotation({ tool, action })),
  ),
]);

describe("the texts that read get_state keep working with the abridged state", () => {
  const all = texts();

  it("finds the skills, the agents and the constitution that read it", () => {
    const names = all.map(({ name }) => name);
    expect(names).toContain("constitution");
    expect(names.some((name) => name.startsWith("skills/develop-story/"))).toBe(true);
    expect(names.some((name) => name.startsWith("agents/noah/"))).toBe(true);
    expect(all.length).toBeGreaterThan(40);
  });

  it("keeps every field of the complete state at the top of the abridged one", () => {
    for (const key of Object.keys(full)) expect(Object.keys(view), key).toContain(key);
  });

  it("cites only fields that exist in the abridged state or in the answer of an option", () => {
    const missing: string[] = [];
    for (const { name, text } of all) {
      for (const span of new Set(spans(text))) {
        if (!/^[a-z_][a-z0-9_]*(\.[a-z0-9_<>*]+)+$/.test(span)) continue;
        const path = span.split(".");
        if (!ROOT_KEYS.has(path[0] as string)) continue;
        if ([...NOT_FIELDS].some((name) => span === name || span.startsWith(`${name}.`))) continue;
        if (!ROOTS.some((root) => resolves(path, root))) missing.push(`${name}: \`${span}\``);
      }
    }
    expect(missing).toEqual([]);
  });

  it("writes only valid calls of the options, each one finding something", () => {
    const calls: string[] = [];
    for (const { name, text } of all) {
      for (const span of new Set(spans(text))) {
        const match = /^state\.get (\{.*\})$/.exec(span);
        if (match === null) continue;
        calls.push(`${name}: ${span}`);
        const json = (match[1] as string).replace(/([{,]\s*)([a-z_]+)\s*:/g, '$1"$2":');
        const input = sample(JSON.parse(json));
        const parsed = GetStateInputSchema.safeParse(input);
        expect(parsed.success, `${name}: ${span}`).toBe(true);
        if (!parsed.success) continue;
        // `full`: the whole abridged state, which `fitState` computes.
        if (parsed.data.full === true) continue;
        const outcome = stateDetail(full, parsed.data);
        expect(outcome?.found, `${name}: ${span}`).toBe(true);
        if (outcome?.found && outcome.value.detail === "checkpoints") {
          expect(outcome.value.checkpoints.length, `${name}: ${span}`).toBeGreaterThan(0);
        }
      }
    }
    // The skills do use them.
    expect(calls.length).toBeGreaterThan(30);
    for (const option of STATE_OPTIONS.filter(
      (option) => option !== "delegations" && option !== "full",
    )) {
      expect(
        calls.some((call) => call.includes(`{ ${option}:`)),
        option,
      ).toBe(true);
    }
  });

  it("does not cite a field of the complete state that the abridged one dropped", () => {
    // Fields the complete checkpoint has and the digests leave to \`checkpoint\`: a text that cites
    // one as read from the state must name the option.
    const dropped = ["options", "measures", "verdict", "criteria", "untrusted", "proof"];
    const offenders: string[] = [];
    for (const { name, text } of all) {
      for (const span of new Set(spans(text))) {
        const match = /^checkpoints\.<id>\.(\w+)/.exec(span);
        if (match !== null && dropped.includes(match[1] as string))
          offenders.push(`${name}: ${span}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
