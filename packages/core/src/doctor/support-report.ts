import { ErrorCode } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { readDoctorCatalog } from "./catalog.js";
import type { EnvironmentProbe } from "./environment-probe.js";
import type { Localized } from "./fixes.js";
import {
  type DoctorItem,
  type DoctorReport,
  type DoctorStatus,
  environmentChecks,
  evaluateChecks,
} from "./report.js";

/**
 * The report to attach to a request for help: the system, the versions and the result
 * of every check of `doctor`, with nothing personal in it. What is removed is a closed list
 * (`REDACTIONS`), shown at the end of the report and checked by a test that gives each kind a
 * sample. The policy is deny by default: a fact the policy does not know is dropped, and a last net
 * of patterns (paths, addresses, tokens, secret-looking words) reads every sentence again.
 */

export type RedactionKind =
  | "user"
  | "home"
  | "project"
  | "path"
  | "host"
  | "email"
  | "name"
  | "tool"
  | "secret";

/** What is removed, in the words of the report. */
export const REDACTIONS: readonly (Localized & { readonly kind: RedactionKind })[] = [
  {
    kind: "user",
    en: "the name of your account on this machine",
    fr: "le nom de ton compte sur cette machine",
  },
  {
    kind: "home",
    en: "the path of your personal folder (shown as [home])",
    fr: "le chemin de ton dossier personnel (remplacé par [home])",
  },
  {
    kind: "project",
    en: "the folder of your product and its name (shown as [project])",
    fr: "le dossier de ton produit et son nom (remplacé par [project])",
  },
  {
    kind: "path",
    en: "every other path outside the system's own folders (shown as [path])",
    fr: "tout autre chemin hors des dossiers du système (remplacé par [path])",
  },
  {
    kind: "host",
    en: "the names of servers, proxies and registries, except the public ones (shown as [host])",
    fr: "les noms de serveurs, de proxies et de registres, sauf les publics (remplacé par [host])",
  },
  {
    kind: "email",
    en: "e-mail addresses, Git's included (shown as [email])",
    fr: "les adresses e-mail, celle de Git comprise (remplacé par [email])",
  },
  {
    kind: "name",
    en: "the name Git signs your commits with (shown as [name])",
    fr: "le nom dont Git signe tes commits (remplacé par [name])",
  },
  {
    kind: "tool",
    en: "the names of the tools your product's architecture asks for (shown as [tool])",
    fr: "les noms des outils que l'architecture de ton produit demande (remplacé par [tool])",
  },
  {
    kind: "secret",
    en: "tokens, passwords, keys and the values of variables that look secret (shown as [secret])",
    fr: "les jetons, mots de passe, clés et valeurs de variables qui ressemblent à un secret (remplacé par [secret])",
  },
];

// --- The policy on the facts of the sentences ----------------------------------------------------

type FactPolicy = "keep" | "path" | "project" | "name" | "email" | "host" | "via" | "drop";

/**
 * What to do with each fact the catalogue's sentences use. A fact missing from this table is
 * dropped (`[value]`); a test requires every placeholder of the shipped catalogue to be listed.
 */
export const FACT_POLICY: Readonly<Record<string, FactPolicy>> = {
  // Program names, versions, numbers and fixed words: nothing personal.
  name: "keep",
  names: "keep",
  version: "keep",
  min: "keep",
  max: "keep",
  needed: "keep",
  memory: "keep",
  free: "keep",
  port: "keep",
  from: "keep",
  to: "keep",
  count: "keep",
  length: "keep",
  windows_long: "keep",
  autocrlf: "keep",
  attributes: "keep",
  forge: "keep",
  forge_name: "keep",
  cli: "keep",
  missing: "keep",
  // Folders.
  path: "path",
  dir: "path",
  dirs: "path",
  first: "path",
  folder: "project",
  // Identity.
  git_name: "name",
  user_name: "name",
  git_email: "email",
  user_email: "email",
  // Network.
  host: "host",
  via: "via",
  // Text taken from the product's architecture or from a failure: never in a report.
  why: "drop",
  text: "drop",
  placeholders: "drop",
};

/** The servers anyone knows: their name tells nothing about the person. */
const PUBLIC_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "registry.npmjs.org",
  "npmjs.org",
  "nodejs.org",
  "git-scm.com",
  "docker.com",
  "hub.docker.com",
  "registry-1.docker.io",
  "agentplugged.ai",
]);

/** Accounts every machine has: their name says nothing about the person. */
const GENERIC_ACCOUNTS = new Set(["root", "admin", "administrator"]);

/** Names of environment variables whose value is a secret. */
const SECRET_NAME =
  /(?:token|secret|passw(?:or)?d|credential|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?(?:token|key))/i;
/** Proxy variables: the address can carry a user and a password (`NO_PROXY` only lists hosts). */
const PROXY_NAME = /^(?:https?|all)_proxy$/i;
/** A value shorter than this is a word, not a secret: removing it everywhere would only spoil the sentences. */
const MIN_SECRET_LENGTH = 8;

export interface RedactionContext {
  readonly home?: string | undefined;
  readonly user?: string | undefined;
  readonly project?: string | undefined;
  /** Values to remove wherever they appear. */
  readonly values: readonly { readonly value: string; readonly kind: RedactionKind }[];
}

/** Marks a piece put aside while the patterns run (a private-use character, never in a sentence). */
const MARK = String.fromCharCode(0xe000);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A path as a pattern: any separator matches any separator, the case does not matter. */
function pathPattern(path: string): string {
  return path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]+/)
    .map(escapeRegExp)
    .join("[\\\\/]+");
}

/**
 * What follows one of our own folders: the rest of the path, spaces included (a folder called
 * `Mes projets` must not leave `projets` behind), up to a character no path holds here.
 */
const PATH_TAIL = "(?:[\\\\/]+[^\"'<>|*?,;()\\]\\r\\n]*)?";
/** A character of a path without spaces (the system's folders are matched with it), and with them. */
const PATH_CLASS = "[^\\s\"'<>|*?,;()\\]]";
const PATH_CHARS = `${PATH_CLASS}*`;
const PATH_SPACED = "[^\"'<>|*?,;()\\]\\r\\n]";

const WINDOWS_SYSTEM_PATH = new RegExp(
  `\\b[A-Za-z]:[\\\\/](?:Program Files(?: \\(x86\\))?|Windows|ProgramData)(?:[\\\\/]${PATH_CHARS})*`,
  "gi",
);
const POSIX_SYSTEM_PATH = new RegExp(
  `(?<![\\w.:/~)-])/(?:usr|opt|bin|sbin|snap|nix|etc|Applications|Library|System)(?:/${PATH_CHARS})*`,
  "g",
);
// Any other path is read to the end of its name, spaces included: a sentence read by this net has
// had its facts replaced already, so reading too far only hides more.
const WINDOWS_PATH = new RegExp(`\\b[A-Za-z]:[\\\\/](?:${PATH_CLASS}${PATH_SPACED}*)?`, "g");
const UNC_PATH = new RegExp(`\\\\\\\\[^\\s\\\\/]+(?:\\\\${PATH_SPACED}*)?`, "g");
const POSIX_PATH = new RegExp(`(?<![\\w.:/~)-])/(?:${PATH_CLASS}${PATH_SPACED}*)`, "g");
const TILDE_PATH = new RegExp(`(?<![\\w])~(?=[\\\\/]|$|\\s)${PATH_TAIL}`, "g");
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi;
const EMAIL = /[\p{L}\p{N}._+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
/**
 * The shapes of keys and tokens that name themselves (a prefix and a length no ordinary word has),
 * with what the guard before a write calls them. Never a value: a label.
 */
const KEY_SHAPES: ReadonlyArray<{ readonly label: string; readonly shape: RegExp }> = [
  { label: "GitHub token", shape: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { label: "GitHub token", shape: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { label: "GitLab token", shape: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { label: "npm token", shape: /\bnpm_[A-Za-z0-9]{20,}/g },
  { label: "API key (sk-)", shape: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { label: "Stripe key", shape: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { label: "Google API key", shape: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { label: "Google token", shape: /\bya29\.[A-Za-z0-9_-]{20,}/g },
  { label: "Slack token", shape: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: "AWS access key", shape: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "Hugging Face token", shape: /\bhf_[A-Za-z0-9]{34,}/g },
  { label: "SendGrid key", shape: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  {
    label: "JWT",
    shape: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    label: "private key",
    shape:
      /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
];
// Read as a secret when a command's output is kept, but not by the guard: prose says « Basic setup ».
const CREDENTIAL_WORDS = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SECRET_SHAPES: readonly RegExp[] = [
  ...KEY_SHAPES.map(({ shape }) => shape),
  CREDENTIAL_WORDS,
  // A long run of letters and digits: a key, a hash, a token of a kind not listed above.
  /\b[A-Za-z0-9+/_=-]{32,}\b/g,
];

/**
 * The same shapes for the guard before a write, which reads text an agent chose, up to millions of
 * characters, in the time of a hook. Each one asks for the shortest token (a fixed length) and no
 * more, so that reading it takes time in proportion to the text: `{20,}` would run to the end of a
 * long run of letters at every prefix it meets. A private key is its header followed by the first
 * characters of its body, so that a header quoted in a document is no key.
 */
const KEY_DETECTORS: ReadonlyArray<{ readonly label: string; readonly shape: RegExp }> = [
  { label: "GitHub token", shape: /\bgithub_pat_[A-Za-z0-9_]{20}/g },
  { label: "GitHub token", shape: /\bgh[pousr]_[A-Za-z0-9]{20}/g },
  { label: "GitLab token", shape: /\bglpat-[A-Za-z0-9_-]{16}/g },
  { label: "npm token", shape: /\bnpm_[A-Za-z0-9]{20}/g },
  { label: "API key (sk-)", shape: /\bsk-[A-Za-z0-9_-]{16}/g },
  { label: "Stripe key", shape: /\bsk_(?:live|test)_[A-Za-z0-9]{16}/g },
  { label: "Google API key", shape: /\bAIza[0-9A-Za-z_-]{30}/g },
  { label: "Google token", shape: /\bya29\.[A-Za-z0-9_-]{20}/g },
  { label: "Slack token", shape: /\bxox[abprs]-[A-Za-z0-9-]{10}/g },
  { label: "AWS access key", shape: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "Hugging Face token", shape: /\bhf_[A-Za-z0-9]{34}/g },
  { label: "SendGrid key", shape: /\bSG\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}/g },
  // The header of a JWT begins with the base64url of `{"alg"`, `{"typ"`, `{"kid"` or `{"cty"`.
  {
    label: "JWT",
    shape:
      /\beyJ(?:hbGci|0eXAi|raWQi|jdHki)[A-Za-z0-9_-]{1,100}\.[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8}/g,
  },
  {
    label: "private key",
    shape: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\r\n]{0,4}[A-Za-z0-9+/=]{40}/g,
  },
];

/** Words a made-up key carries (documentation, fixtures): such a token is no secret. */
const PLACEHOLDER = /example|your|placeholder|changeme|dummy|fake|sample|redacted|x{4,}|\.\.\./i;

/** True for a token that is plainly not a real one: it says so, or it is a few characters repeated. */
function isPlaceholder(token: string): boolean {
  return PLACEHOLDER.test(token) || new Set(token).size <= 8;
}

/**
 * The kind of secret `text` shows, or undefined: only the shapes that name themselves, never a long
 * run of characters nor a word like `password` (a hash or an identifier is no secret), and not a
 * token that says it is an example. The guard before a write refuses on this alone; it
 * returns a label, never a part of the value.
 */
export function secretKind(text: string): string | undefined {
  for (const { label, shape } of KEY_DETECTORS) {
    for (const match of text.matchAll(shape)) {
      if (!isPlaceholder(match[0])) return label;
    }
  }
  return undefined;
}
const SECRET_WORD =
  /\b(token|password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth)(\s*[=:]\s*)\S+/gi;

/**
 * A word that names a secret, anywhere in a name (`DB_PASSWORD=…`, `"api_key": "…"`, `Authorization: …`),
 * then its value: quoted, or up to the next blank.
 */
const SECRET_ASSIGNMENT =
  /((?:token|passw(?:or)?d|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credential)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi;

const TOKEN = {
  user: "[user]",
  home: "[home]",
  project: "[project]",
  path: "[path]",
  host: "[host]",
  email: "[email]",
  name: "[name]",
  tool: "[tool]",
  secret: "[secret]",
} as const satisfies Record<RedactionKind, string>;

/**
 * `text` with the secrets it shows replaced by `[secret]`: the known shapes of keys and tokens
 * (GitHub, GitLab, npm, Stripe, AWS, Slack, Google, JWT, private keys, `Bearer …`), a long run of
 * letters and digits, `password=…` and the like, and the credentials of an address. Nothing else is
 * touched (a path, a name stay): it is what a command's output goes through before it is kept.
 */
export function maskSecrets(text: string): string {
  let out = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${TOKEN.secret}@`);
  for (const shape of SECRET_SHAPES) out = out.replace(shape, TOKEN.secret);
  out = out.replace(SECRET_WORD, `$1$2${TOKEN.secret}`);
  return out.replace(SECRET_ASSIGNMENT, `$1${TOKEN.secret}`);
}

/** The host of an address, lowercase, without port or user; undefined when it is not one. */
function hostOf(address: string): string | undefined {
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]*@)?(\[[^\]]+\]|[^/:\s?#]+)/i.exec(
    address.trim(),
  );
  return match?.[1]?.toLowerCase();
}

const isPublicHost = (host: string | undefined) =>
  host !== undefined &&
  (PUBLIC_HOSTS.has(host) || [...PUBLIC_HOSTS].some((known) => host.endsWith(`.${known}`)));

/** Reads a sentence again and removes what is personal in it. */
export function redactText(text: string, context: RedactionContext): string {
  let out = text;
  // 1. Our own folders, whole (they may hold spaces, accents), the product's first.
  for (const [folder, kind] of [
    [context.project, "project"],
    [context.home, "home"],
  ] as const) {
    if (folder === undefined || folder.replace(/[\\/]/g, "").length < 2) continue;
    out = out.replace(new RegExp(`${pathPattern(folder)}${PATH_TAIL}`, "gi"), TOKEN[kind]);
    // The product's name, wherever it appears alone (a branch, a folder name in a sentence).
    const base = folder
      .split(/[\\/]+/)
      .filter((part) => part !== "")
      .at(-1);
    if (kind === "project" && base !== undefined && base.length >= 8) {
      out = out.replace(
        new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(base)}(?![\\p{L}\\p{N}])`, "giu"),
        TOKEN.project,
      );
    }
  }
  // 2. Values to remove wherever they are, the longest first.
  const values = [...context.values]
    .filter((entry) => entry.value.trim().length >= 3)
    .sort((a, b) => b.value.length - a.value.length);
  for (const { value, kind } of values) {
    out = out.replace(new RegExp(escapeRegExp(value.trim()), "gi"), TOKEN[kind]);
  }
  // 3. The account's name, as a word.
  const user = context.user?.trim();
  if (user !== undefined && user.length >= 3 && !GENERIC_ACCOUNTS.has(user.toLowerCase())) {
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(user)}(?![\\p{L}\\p{N}])`, "giu"),
      TOKEN.user,
    );
  }
  // 4. What is allowed to stay is put aside, so that the patterns below cannot touch it.
  const kept: string[] = [];
  const keep = (match: string) => {
    kept.push(match);
    return `${MARK}${kept.length - 1}${MARK}`;
  };
  out = out.replace(URL, (address) => {
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*@/i.test(address)) return TOKEN.secret;
    const host = hostOf(address);
    if (!isPublicHost(host)) return TOKEN.host;
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(address)?.[0] ?? "";
    return keep(`${scheme}${host ?? ""}`);
  });
  out = out.replace(WINDOWS_SYSTEM_PATH, keep).replace(POSIX_SYSTEM_PATH, keep);
  // 5. The patterns.
  out = out.replace(UNC_PATH, TOKEN.path).replace(WINDOWS_PATH, TOKEN.path);
  out = out.replace(TILDE_PATH, TOKEN.home).replace(POSIX_PATH, TOKEN.path);
  out = out.replace(EMAIL, TOKEN.email);
  out = maskSecrets(out);
  return out.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (_all, index: string) => {
    return kept[Number(index)] ?? "";
  });
}

/** One fact of a sentence, by the policy. */
export function redactFact(key: string, value: string, context: RedactionContext): string {
  const policy = FACT_POLICY[key] ?? "drop";
  switch (policy) {
    case "keep":
      return redactText(value, context);
    case "path":
      return value
        .split(" ; ")
        .map((folder) => redactText(folder, context))
        .join(" ; ");
    case "project":
      return value === "" ? "" : TOKEN.project;
    case "name":
      return value === "" ? "" : TOKEN.name;
    case "email":
      return value === "" ? "" : TOKEN.email;
    case "host": {
      // Only the name of the server: a public one can carry a path (an organisation, a repository).
      const host = hostOf(value);
      return value === "" ? "" : isPublicHost(host) ? (host ?? TOKEN.host) : TOKEN.host;
    }
    case "via":
      // `HTTPS_PROXY (proxy.corp:3128) ; npm registry (registry.npmjs.org)`: the names of the
      // settings stay, the servers go unless they are public.
      return value.replace(/\(([^)]*)\)/g, (_all, host: string) =>
        isPublicHost(hostOf(host)) ? `(${host})` : `(${TOKEN.host})`,
      );
    case "drop":
      return value === "" ? "" : "[value]";
  }
}

/** The whole record of facts of a sentence, by the policy. */
export function redactFacts(
  facts: Readonly<Record<string, string>>,
  context: RedactionContext,
  options: { readonly tool?: boolean } = {},
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(facts).map(([key, value]) => [
      key,
      // The tools of the product's architecture are the product's own choice: not named.
      options.tool === true && (key === "name" || key === "names") && value !== ""
        ? TOKEN.tool
        : redactFact(key, value, context),
    ]),
  );
}

// --- The report ----------------------------------------------------------------------------------

export interface SupportCheck {
  /** Stable identifier: `git.identity`. */
  readonly id: string;
  readonly group: string;
  readonly status: DoctorStatus;
  readonly outcome: string;
  readonly text: Localized;
}

export interface SupportReport {
  readonly format: 1;
  readonly engine: string;
  readonly system: {
    readonly platform: string;
    readonly arch: string;
    readonly release: string;
    readonly node: string;
    /** The shell named by the `SHELL` variable (an indication: Windows terminals do not set it). */
    readonly shell: string;
    readonly interactive: boolean;
    readonly ci: boolean;
  };
  readonly versions: readonly { readonly tool: string; readonly version: string }[];
  readonly checks: readonly SupportCheck[];
  /** Checks whose reading failed on this machine (they are not in `checks`). */
  readonly unreadable: readonly string[];
  readonly counts: DoctorReport["counts"];
  /** What was removed, kind by kind. */
  readonly removed: readonly (Localized & { readonly kind: RedactionKind })[];
}

/** The programs whose version a support person asks first. */
const VERSIONED_TOOLS = ["git", "gh", "glab", "npm", "pnpm", "docker"] as const;
const VERSION_TIMEOUT_MS = 8_000;

/** The shell's name, never its path. */
function shellOf(probe: EnvironmentProbe): string {
  const raw = probe.env("SHELL");
  if (raw === undefined) return "?";
  const name = raw.split(/[\\/]+/).at(-1) ?? "?";
  return /^[\w.+-]{1,32}$/.test(name) ? name : "?";
}

async function versionsOf(probe: EnvironmentProbe): Promise<SupportReport["versions"]> {
  const found = await Promise.all(
    VERSIONED_TOOLS.map(async (tool): Promise<{ tool: string; version: string } | undefined> => {
      try {
        const program = await probe.find([tool]);
        if (program === undefined) return undefined;
        const run = await probe.run([program.path, "--version"], { timeoutMs: VERSION_TIMEOUT_MS });
        if (run.status !== 0) return undefined;
        // Only the number: what else a program prints can carry a path or a user.
        const version = /\d+\.\d+(?:\.\d+)?/.exec(`${run.stdout}\n${run.stderr}`.trim())?.[0];
        return version === undefined ? undefined : { tool, version };
      } catch {
        return undefined;
      }
    }),
  );
  return found.filter((entry): entry is { tool: string; version: string } => entry !== undefined);
}

/** What the machine says is private, as values to remove. */
export async function redactionContextOf(probe: EnvironmentProbe): Promise<RedactionContext> {
  const machine = probe.describeMachine();
  const values: { value: string; kind: RedactionKind }[] = [];
  const add = (value: string | undefined, kind: RedactionKind) => {
    if (value !== undefined && value.trim() !== "") values.push({ value: value.trim(), kind });
  };
  add(await probe.gitConfig("user.name"), "name");
  add(await probe.gitConfig("user.email"), "email");
  add(await probe.gitConfig("http.proxy"), "secret");
  for (const name of probe.envNames()) {
    if (!SECRET_NAME.test(name) && !PROXY_NAME.test(name)) continue;
    const value = probe.env(name);
    if (value !== undefined && value.length >= MIN_SECRET_LENGTH) add(value, "secret");
  }
  return {
    home: machine.home,
    user: machine.user,
    project: probe.workingFolder(),
    values,
  };
}

/**
 * The support report: every check of the catalogue (the ones that only matter after a failure
 * too) and of the architecture's prerequisites, in words that name nothing personal. It looks and
 * never repairs.
 */
export async function buildSupportReport(
  context: CommandContext,
): Promise<SupportReport | AgentPluggedError> {
  const probe = context.environment;
  if (probe === undefined) {
    return new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
      reason: "the machine cannot be looked at here",
    });
  }
  const catalog = await readDoctorCatalog(context.method);
  if (catalog instanceof AgentPluggedError) return catalog;
  const redaction = await redactionContextOf(probe);
  const checks = await environmentChecks(context, catalog);
  const crashed: string[] = [];
  const items: DoctorItem[] = await evaluateChecks(context, checks, {
    facts: (facts, check) =>
      redactFacts(facts, redaction, { tool: check.id.startsWith("prerequisite.tool.") }),
    fixes: false,
    crashed,
  });
  // What the product's architecture asks for is its own: the points keep their kind and a number.
  const numbered = new Map<string, string>();
  const publicId = (id: string): string => {
    const kind = /^prerequisite\.(tool|port|memory)\b/.exec(id)?.[1];
    if (kind === undefined) return id;
    const known = numbered.get(id);
    if (known !== undefined) return known;
    const made = `prerequisite.${kind}.${[...numbered.values()].filter((value) => value.startsWith(`prerequisite.${kind}.`)).length + 1}`;
    numbered.set(id, made);
    return made;
  };
  const machine = probe.describeMachine();
  const counts = {
    ok: items.filter((item) => item.status === "ok").length,
    warn: items.filter((item) => item.status === "warn").length,
    fail: items.filter((item) => item.status === "fail").length,
  };
  return {
    format: 1,
    engine: context.engineVersion,
    system: {
      platform: probe.platform,
      arch: machine.arch,
      release: machine.release,
      node: probe.nodeVersion(),
      shell: shellOf(probe),
      interactive: context.interactive === true,
      ci: !["", "0", "false"].includes((probe.env("CI") ?? "").toLowerCase()),
    },
    versions: await versionsOf(probe),
    checks: items.map((item) => ({
      id: publicId(item.id),
      group: item.group,
      status: item.status,
      outcome: item.outcome,
      // The sentence is read again by the patterns: whatever the policy let through.
      text: {
        en: redactText(item.text.en, redaction),
        fr: redactText(item.text.fr, redaction),
      },
    })),
    unreadable: crashed.map(publicId),
    counts,
    removed: REDACTIONS,
  };
}
