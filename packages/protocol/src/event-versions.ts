/**
 * Conversions of older event formats, declared by `(type, version)`: each one turns the payload
 * of `type` at `version` into the payload of `version + 1`. Applied when the journal is read,
 * never written back (an event file is never rewritten). Kept free of imports: the envelope
 * schema accepts an older `v` only when a conversion is declared for it.
 */
export interface EventConversion {
  readonly type: string;
  /** The version converted from; the result is `from + 1`. */
  readonly from: number;
  convert(payload: Readonly<Record<string, unknown>>): Record<string, unknown>;
}

/**
 * Type reserved to tests: it proves the type registry, the reducers and the conversions without
 * any business meaning. Never written by a command.
 */
export const TEST_EVENT_TYPE = "test.appended";

export const EVENT_CONVERSIONS: readonly EventConversion[] = [
  {
    // Version 0 of the test type named its counter `number`; version 1 names it `n`.
    type: TEST_EVENT_TYPE,
    from: 0,
    convert: ({ number, ...rest }) => (number === undefined ? { ...rest } : { ...rest, n: number }),
  },
  {
    // Version 2 of `checkpoint.opened` adds the `phase_end` type and its `phase` field (story
    // 3.2), and the optional `request`, `untrusted` and source `untrusted_action`.
    // A version 1 payload is a version 2 payload as is; an engine that knows only version 1 meets
    // a version 2 event with `UPGRADE_REQUIRED` instead of misreading or dropping it.
    type: "checkpoint.opened",
    from: 1,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 3 of `checkpoint.opened` adds the `creator_action` type and its `creator_action`
    // field. A version 2 payload is a version 3 payload as is.
    type: "checkpoint.opened",
    from: 2,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 4 of `checkpoint.opened` adds the `memory` type and its `memory` field.
    // A version 3 payload is a version 4 payload as is.
    type: "checkpoint.opened",
    from: 3,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 5 of `checkpoint.opened`: the `creator_action` of an `agent_create` or `agent_edit`
    // carries the complete `content` of the definition. A version 4 payload is a
    // version 5 payload as is.
    type: "checkpoint.opened",
    from: 4,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 2 of `creator_action.executed` adds the source `elicitation`: an
    // approval clicked in the AI tool's form. A version 1 payload is a version 2 payload as is.
    type: "creator_action.executed",
    from: 1,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 3 of `creator_action.executed`: its `action` may carry the `content` of an agent or
    // skill. A version 2 payload is a version 3 payload as is.
    type: "creator_action.executed",
    from: 2,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 6 of `checkpoint.opened`: the `creator_action` may be one of the three gestures of
    // the forge (`forge_repo_create`, `forge_push_main`, `forge_merge_ci`) or a `profile` that
    // sets `installs`. A version 5 payload is a version 6 payload as is.
    type: "checkpoint.opened",
    from: 5,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 4 of `creator_action.executed`: its `action` may be one of the gestures of the forge
    // or a `profile` that sets `installs`. A version 3 payload is a version 4 payload
    // as is.
    type: "creator_action.executed",
    from: 3,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 7 of `checkpoint.opened`: the `creator_action` may be `step_skip` or `step_resume`
    //. A version 6 payload is a version 7 payload as is.
    type: "checkpoint.opened",
    from: 6,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 5 of `creator_action.executed`: its `action` may be `step_skip` or `step_resume`
    //. A version 4 payload is a version 5 payload as is.
    type: "creator_action.executed",
    from: 4,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 8 of `checkpoint.opened`: the `creator_action` may be `engine_update`. A
    // version 7 payload is a version 8 payload as is.
    type: "checkpoint.opened",
    from: 7,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 6 of `creator_action.executed`: its `action` may be `engine_update`. A
    // version 5 payload is a version 6 payload as is.
    type: "creator_action.executed",
    from: 5,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 9 of `checkpoint.opened`: the `creator_action` may be `release`, or a `profile` that sets
    // the Git `workflow`. A version 8 payload is a version 9 payload as is.
    type: "checkpoint.opened",
    from: 8,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 7 of `creator_action.executed`: its `action` may be `release`, or a `profile` that sets
    // the Git `workflow`. A version 6 payload is a version 7 payload as is.
    type: "creator_action.executed",
    from: 6,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 10 of `checkpoint.opened`: the `creator_action` may be `environment_fix`.
    // A version 9 payload is a version 10 payload as is.
    type: "checkpoint.opened",
    from: 9,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 8 of `creator_action.executed`: its `action` may be `environment_fix`. A
    // version 7 payload is a version 8 payload as is.
    type: "creator_action.executed",
    from: 7,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 11 of `checkpoint.opened`: the `creator_action` may be `proof_commands`.
    // A version 10 payload is a version 11 payload as is.
    type: "checkpoint.opened",
    from: 10,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 9 of `creator_action.executed`: its `action` may be `proof_commands`. A
    // version 8 payload is a version 9 payload as is.
    type: "creator_action.executed",
    from: 8,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 12 of `checkpoint.opened`: the `creator_action` may be `scope_widen`. A
    // version 11 payload is a version 12 payload as is.
    type: "checkpoint.opened",
    from: 11,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 10 of `creator_action.executed`: its `action` may be `scope_widen`. A
    // version 9 payload is a version 10 payload as is.
    type: "creator_action.executed",
    from: 9,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 13 of `checkpoint.opened`: the content of an `agent_create` or `agent_edit` may give a
    // menu item that calls a skill (`skill`) and a skill its files of detail (`references`, story
    // 17.15). A version 12 payload is a version 13 payload as is.
    type: "checkpoint.opened",
    from: 12,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 11 of `creator_action.executed`: same additions to the content of its `action` (story
    // 17.15). A version 10 payload is a version 11 payload as is.
    type: "creator_action.executed",
    from: 10,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 14 of `checkpoint.opened`: the `agent_edit` of its `creator_action` may carry the
    // customisation of a skill shipped with the method as its `content`, and a `layer` (story
    // 18.7). A version 13 payload is a version 14 payload as is.
    type: "checkpoint.opened",
    from: 13,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 12 of `creator_action.executed`: same additions to its `action`. A
    // version 11 payload is a version 12 payload as is.
    type: "creator_action.executed",
    from: 11,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 2 of `requirement.proved` carries the `origin` of a proof and the `run` of the
    // command the engine ran. A version 1 payload is a version 2 payload as is: a
    // proof an agent reported.
    type: "requirement.proved",
    from: 1,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 2 of `story.merged` may be a merge without a pull request (`direct`). A
    // version 1 payload is a version 2 payload as is.
    type: "story.merged",
    from: 1,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 3 of `story.merged` carries the `weight` of the story's code. A version
    // 2 payload is a version 3 payload as is.
    type: "story.merged",
    from: 2,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 2 of `checkpoint.closed` adds the reason `step_skipped`. A version 1
    // payload is a version 2 payload as is.
    type: "checkpoint.closed",
    from: 1,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 2 of `checkpoint.closed` also carries the reasons `block_lifted`, `worktree_gone` and
    // `lapsed`, and version 2 of `checkpoint.answered` adds `anticipated`: an
    // agreement given just before the point opened. A version 1 payload is a version 2 one as is.
    type: "checkpoint.answered",
    from: 1,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 2 of `checkpoint.elicited` adds `via: "question_tool"` and its `proof`: an
    // answer chosen in the AI tool's question tool, proved by the tool's hook. A version 1 payload
    // is a version 2 payload as is.
    type: "checkpoint.elicited",
    from: 1,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 2 of `stack.answered` adds the same `via` and `proof` to an answer of the form's source
    //. A version 1 payload is a version 2 payload as is.
    type: "stack.answered",
    from: 1,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 2 of `cost.reported` adds `billing`, `quota_percent`, `run` and `cumulative` (story
    // 4.3). A version 1 payload is a version 2 payload as is: a delta, billing unknown.
    type: "cost.reported",
    from: 1,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 2 of `usage.measured`: a part may carry the `step` and the `skill` it is attributed
    // to, each with its origin. A version 1 payload is a version 2 payload as is: its
    // parts are unattributed.
    type: "usage.measured",
    from: 1,
    convert: (payload) => ({ ...payload }),
  },
  {
    // Version 2 of `agent.status_reported` adds the `skill` an agent starts. A
    // version 1 payload is a version 2 payload as is.
    type: "agent.status_reported",
    from: 1,
    convert: (payload) => ({ ...payload }),
  },
];

/**
 * The current version of each type above version 1, which every other type is at. A version is
 * raised when a payload gains fields a strict schema of an older engine would refuse: that
 * engine then asks for an upgrade (`UPGRADE_REQUIRED`) instead of ignoring the event as invalid.
 * `checkpoint.opened` is at 2 and at 3 and at 4
 * and at 5 and at 6 and at 7 and at 8 and at 9 and at 10 and at 11 and at 12 and at 13 and at 14, `requirement.proved` at 2, `story.merged` at 2 and at 3, `cost.reported` at 2,
 * `creator_action.executed` at 2, at 3, at 4 and at 5 and at 6 and at 7 and at 8 and at 9 and at 10 and at 11 and at 12, `checkpoint.closed` at 2 (and `checkpoint.answered` at 2),
 * `checkpoint.elicited` and `stack.answered` at 2, `usage.measured` and
 * `agent.status_reported` at 2.
 */
export const EVENT_TYPE_VERSIONS: Readonly<Record<string, number>> = {
  "checkpoint.opened": 14,
  "checkpoint.closed": 2,
  "checkpoint.answered": 2,
  "cost.reported": 2,
  "requirement.proved": 2,
  "creator_action.executed": 12,
  "story.merged": 3,
  "checkpoint.elicited": 2,
  "stack.answered": 2,
  "usage.measured": 2,
  "agent.status_reported": 2,
};

/** The current version of `type` (1 unless `EVENT_TYPE_VERSIONS` raises it). */
export function currentVersionOf(type: string): number {
  return Object.hasOwn(EVENT_TYPE_VERSIONS, type) ? (EVENT_TYPE_VERSIONS[type] as number) : 1;
}

/** The highest version this engine reads, of any type. */
export const MAX_EVENT_VERSION = Math.max(1, ...Object.values(EVENT_TYPE_VERSIONS));

/** The conversion of `type` from `version`, or undefined when none is declared. */
export function eventConversion(type: string, version: number): EventConversion | undefined {
  return EVENT_CONVERSIONS.find((entry) => entry.type === type && entry.from === version);
}
