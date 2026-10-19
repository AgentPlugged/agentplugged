import { z } from "zod";
import { isCanonicalBase64url } from "./event-envelope.js";

/**
 * The read-only progress page: a page a creator shares without any account. The device builds it
 * from a short allow-list (never a copy of the state), seals it with a key made for this one link,
 * and hands the relay the sealed bytes only. The key travels in the fragment of the link, which no
 * browser sends to a server, so the relay can neither read the page nor give it to anyone who does
 * not hold the whole link. The relay erases the page at its expiry or when the creator withdraws
 * the link.
 */

/**
 * The stages and the phases a page can name. Written here, not imported, so that the page that
 * reads a link stays light (a test compares them with the lists of the product and of the method).
 */
export const SHARE_STAGES = ["framing", "development", "launch", "online"] as const;
export const SHARE_PHASES = [
  "framing",
  "planning",
  "design",
  "build",
  "delivery",
  "launch",
] as const;

/** How long a link works: 30 days, fixed by the relay (the device cannot ask for more). */
export const SHARE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/** The most links an account may have active at once. */
export const SHARE_MAX_ACTIVE = 10;
/** The largest sealed page, in bytes. */
export const SHARE_MAX_SEALED_BYTES = 65_536;
/** The most stories a page lists; the others are counted. */
export const SHARE_MAX_STORIES = 60;
/** The associated data the page is sealed with: a page sealed for another use does not open. */
export const SHARE_SEAL_CONTEXT = "agentplugged/share/v1";

/** The identifier of a link: 16 random bytes, in base64url (22 characters). */
export const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** The key of a link: 32 random bytes, in base64url (43 characters). */
export const SHARE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The routes of the links: the first three need a signed-in session, the last one needs nothing. */
export const SHARE_ROUTES = {
  /** `POST` makes a link from a sealed page; `GET` lists the links that are active. */
  collection: "/account/shares",
  /** `POST` withdraws a link: it stops working at once. */
  revoke: "/account/shares/revoke",
  /** The public route, followed by the identifier: `GET` gives the sealed page to anyone. */
  publicPrefix: "/share/",
} as const;

/** The address of a link, from its parts: the identifier and the key are in the fragment. */
export function shareLinkOf(origin: string, id: string, key: string): string {
  return `${origin.replace(/\/+$/, "")}/s/#${id}.${key}`;
}

/** The parts of a link's fragment, or `undefined` when it is not one. */
export function parseShareFragment(fragment: string): { id: string; key: string } | undefined {
  const text = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const dot = text.indexOf(".");
  if (dot < 0) return undefined;
  const id = text.slice(0, dot);
  const key = text.slice(dot + 1);
  return SHARE_ID_PATTERN.test(id) && SHARE_KEY_PATTERN.test(key) ? { id, key } : undefined;
}

const sealedText = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .max(Math.ceil((maxBytes * 4) / 3))
    .refine(isCanonicalBase64url);

const PRODUCT_REF = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** What the device sends to make a link: the product it belongs to (an opaque reference) and the sealed page. */
export const ShareCreateRequestSchema = z.strictObject({
  product: z.string().regex(PRODUCT_REF),
  /** 12 bytes. */
  nonce: z.string().length(16).refine(isCanonicalBase64url),
  ciphertext: sealedText(SHARE_MAX_SEALED_BYTES),
});
export type ShareCreateRequest = z.infer<typeof ShareCreateRequestSchema>;

export const ShareRevokeRequestSchema = z.strictObject({ id: z.string().regex(SHARE_ID_PATTERN) });

/** A link as the relay lists it: no content, no key; dates are ISO 8601. */
export interface ShareSummary {
  id: string;
  product: string;
  created_at: string;
  expires_at: string;
}

/** What the public route gives: the sealed page and when it stops working. */
export interface SharePublicReply {
  nonce: string;
  ciphertext: string;
  expires_at: string;
}

// --- the page ---------------------------------------------------------------------------------

export const SHARE_PHASE_STATES = ["done", "current", "review", "upcoming"] as const;
export const SHARE_STORY_STATES = ["todo", "development", "review", "done"] as const;
export type ShareStoryState = (typeof SHARE_STORY_STATES)[number];

const NAME_MAX = 80;
const GOAL_MAX = 160;
const TITLE_MAX = 120;

/**
 * The page, strict. It is the whole allow-list: progress (phases, stories), the stage, the sprint's
 * goal and the stories with their steps. There is no field for a cost, a path, code, a secret, an
 * agent, a machine or a device, so none can be added by mistake in the code that fills it.
 */
export const SharePageSchema = z.strictObject({
  v: z.literal(1),
  /** When the page was made, in milliseconds since the epoch. */
  made_at: z.number().int().nonnegative(),
  product: z.strictObject({
    name: z.string().min(1).max(NAME_MAX),
    stage: z.enum(SHARE_STAGES),
  }),
  phases: z
    .array(
      z.strictObject({
        id: z.enum(SHARE_PHASES),
        state: z.enum(SHARE_PHASE_STATES),
      }),
    )
    .max(SHARE_PHASES.length),
  sprint: z
    .strictObject({
      goal: z.string().min(1).max(GOAL_MAX).nullable(),
      done: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .nullable(),
  /** Stories merged, all sprints together. */
  delivered: z.number().int().nonnegative(),
  stories: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Za-z0-9.-]{1,16}$/),
        /** `null` when the title was held back or the story has none. */
        title: z.string().min(1).max(TITLE_MAX).nullable(),
        state: z.enum(SHARE_STORY_STATES),
        /** Steps (acceptance criteria) proven out of those the story lists; `null` when none is listed. */
        steps: z
          .strictObject({
            done: z.number().int().nonnegative(),
            total: z.number().int().nonnegative(),
          })
          .nullable(),
      }),
    )
    .max(SHARE_MAX_STORIES),
  /** Stories of the sprint past the limit, counted and not listed. */
  more: z.number().int().nonnegative(),
});
export type SharePage = z.infer<typeof SharePageSchema>;

/** What the web view knows of a product and hands over to be shared (it picks nothing itself). */
export interface ShareSource {
  readonly name: string;
  readonly stage: (typeof SHARE_STAGES)[number];
  readonly phases: readonly {
    readonly id: (typeof SHARE_PHASES)[number];
    readonly state: (typeof SHARE_PHASE_STATES)[number];
  }[];
  readonly sprint: {
    readonly goal: string | null;
    readonly done: number;
    readonly total: number;
  } | null;
  readonly delivered: number;
  readonly stories: readonly {
    readonly id: string;
    readonly title: string | null;
    readonly state: ShareStoryState;
    readonly steps: { readonly done: number; readonly total: number } | null;
  }[];
  readonly now: number;
}

/**
 * The shapes of text that look like a secret: the same list as the exit guard of the machines and
 * the publication guard of the npm archive (a test of the bridge fails when they differ).
 */
export const SHARE_SECRET_PATTERNS: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
  ["private key (PEM)", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ["GitHub token (ghp_)", /\bghp_[A-Za-z0-9]{30,}/],
  ["GitHub token (github_pat_)", /\bgithub_pat_[A-Za-z0-9_]{22,}/],
  ["GitLab token (glpat-)", /\bglpat-[A-Za-z0-9_-]{20,}/],
  ["Anthropic key (sk-ant-)", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["npm token (npm_)", /\bnpm_[A-Za-z0-9]{30,}/],
  ["AWS access key (AKIA)", /\bAKIA[0-9A-Z]{16}\b/],
];

/**
 * More shapes, for a page that goes to anyone: a text typed by hand (a sprint's goal, a title) is
 * not checked by the exit guard of a machine, so the page holds back the usual families of keys,
 * tokens and credentials too, and any long unbroken run of key-like characters.
 */
const EXTRA_SECRET_SHAPES: readonly RegExp[] = [
  /\bsk[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}/,
  /\b[sp]k_(?:live|test)_[A-Za-z0-9]{10,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]/i,
  /[A-Za-z0-9_+/=-]{32,}/,
];

/** The marker a machine leaves where its exit guard held a text back. */
const MACHINE_MARKER = "redacted:secret";

/** Characters that hide or reorder text: controls, zero-width, bidirectional marks. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁯﻿￹-￻]/g;

/** The invisible « tag » characters, which can carry a hidden text. */
const TAG_CHARACTERS = /[\u{E0000}-\u{E007F}]/gu;

/** A path of a file or a folder: absolute, in a home folder, or deep enough to be one. */
const PATH_SHAPES: readonly RegExp[] = [
  /(?:^|[\s"'`(=])[A-Za-z]:[\\/]/,
  /(?:^|[\s"'`(=])\\\\[^\s\\]/,
  /(?:^|[\s"'`(=])~[\\/]/,
  /(?:^|[\s"'`(=])\/(?:home|users|etc|var|usr|opt|root|mnt|tmp|srv|private|volumes)\b/i,
  /(?=[\w.@\\/-]*[A-Za-z])(?:[\w.@-]+[\\/]){2,}[\w.@-]+/,
  /[\w.@-]+[\\/][\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,5}\b/,
  /(?:^|[\s"'`(])\.{1,2}[\\/]/,
  /\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|java|kt|swift|rb|php|json|ya?ml|toml|env|sh|sql|css|html?|lock|md|txt|ini|cfg|conf|pem|key|log|csv|xml|properties)\b/i,
  /\bid_(?:rsa|ed25519|ecdsa|dsa)\b/i,
  /\b(?:src|lib|dist|build|node_modules|packages|apps|tests?|\.git|\.github)[\\/]\w/i,
  // Two segments, one of which looks like a name of a file or a folder (a dot or an underscore).
  /(?:^|[\s"'`(])[\w.-]*[._][\w.-]*[\\/][\w.-]+/,
  /(?:^|[\s"'`(])[\w-]+[\\/][\w.-]*[._][\w.-]*/,
];

/** An address of any kind, a machine's name on a network, a private or any numeric address, an e-mail. */
const ADDRESS_SHAPES: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\//i,
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b[\w-]+\.(?:local|internal|lan|corp|home|intranet)\b/i,
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /\blocalhost\b/i,
];

/**
 * A text with its hidden and direction-changing characters taken out and its spaces folded. The
 * page that shows a text applies it again whatever it received: what is shown is never trusted to
 * have been cleaned by whoever made it.
 */
export function cleanShareText(value: string): string {
  return value.replace(HIDDEN, " ").replace(TAG_CHARACTERS, " ").replace(/\s+/g, " ").trim();
}

/**
 * A text of the page, or `undefined` when it must not leave: it looks like a secret, a path, a
 * private address, or it is the marker a machine left where it held a text back. Hidden and
 * direction-changing characters are removed, spaces are folded, and the text is cut at `max`.
 */
export function shareText(value: string, max: number): string | undefined {
  const text = cleanShareText(value);
  if (text === "" || text === MACHINE_MARKER) return undefined;
  if (SHARE_SECRET_PATTERNS.some(([, pattern]) => pattern.test(text))) return undefined;
  if (EXTRA_SECRET_SHAPES.some((pattern) => pattern.test(text))) return undefined;
  if (PATH_SHAPES.some((pattern) => pattern.test(text))) return undefined;
  if (ADDRESS_SHAPES.some((pattern) => pattern.test(text))) return undefined;
  if (text.length <= max) return text;
  return `${[...text].slice(0, max - 1).join("")}…`;
}

export interface BuiltSharePage {
  readonly page: SharePage;
  /** How many texts were held back (kept out of the page, not cut in part). */
  readonly withheld: number;
}

const count = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/**
 * Builds the page from what the web view hands over, keeping only what the schema lists and holding
 * back any text that could be a secret or a path. A product whose name has to be held back is
 * called `—`. The result is parsed by the strict schema before it is returned: a page that does not
 * fit is a bug, never a page that is sent.
 */
export function buildSharePage(source: ShareSource): BuiltSharePage {
  let withheld = 0;
  const kept = (value: string | null, max: number): string | null => {
    if (value === null) return null;
    const text = shareText(value, max);
    if (text === undefined) {
      withheld += 1;
      return null;
    }
    return text;
  };
  const stories = source.stories.slice(0, SHARE_MAX_STORIES).map((story) => ({
    id: story.id,
    title: kept(story.title, TITLE_MAX),
    state: story.state,
    steps:
      story.steps === null || story.steps.total <= 0
        ? null
        : {
            done: Math.min(count(story.steps.done), count(story.steps.total)),
            total: count(story.steps.total),
          },
  }));
  const goal = source.sprint === null ? null : kept(source.sprint.goal, GOAL_MAX);
  const page = SharePageSchema.parse({
    v: 1,
    made_at: count(source.now),
    product: { name: kept(source.name, NAME_MAX) ?? "—", stage: source.stage },
    phases: source.phases.map((phase) => ({ id: phase.id, state: phase.state })),
    sprint:
      source.sprint === null
        ? null
        : {
            goal,
            done: Math.min(count(source.sprint.done), count(source.sprint.total)),
            total: count(source.sprint.total),
          },
    delivered: count(source.delivered),
    stories,
    more: Math.max(0, source.stories.length - SHARE_MAX_STORIES),
  });
  return { page, withheld };
}

/** The page parsed from a decrypted text, or `undefined` when it is not a page this version reads. */
export function parseSharePage(text: string): SharePage | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = SharePageSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
