import { forgeOfHost, type RemoteExposure, remoteLocation } from "@agentplugged/core";
import { type GitRun, runGit } from "./git-process.js";

/** How long the anonymous read of a repository may take before its visibility is `unknown`. */
export const EXPOSURE_TIMEOUT_MS = 8_000;

/** The host asks for credentials, or says the repository is not there for anyone not allowed to read it. */
const STRONG_CREDENTIALS =
  /authentication failed|could not read username|could not read password|terminal prompts disabled|repository not found|invalid credentials/i;

/** The network is down or the host does not answer: nothing is known of the repository. */
const NETWORK_DOWN =
  /could not resolve host|could not resolve hostname|could not connect|failed to connect|connection (?:timed out|refused|reset)|timed out|network is unreachable|no route to host|\bssl\b|certificate|\btls\b|\bproxy\b|temporary failure|took more than|not allowed|\b429\b|\b5\d\d\b|too many requests|rate limit|service unavailable|bad gateway|gateway time-?out|internal server error/i;

/** Weaker words of a refusal: read only once the network is known to answer. */
const WEAK_CREDENTIALS =
  /not found|\b40[134]\b|access denied|permission denied|forbidden|unauthori[sz]ed/i;

/** An address as Git takes it for a place on another machine: `scheme://…`, or `[user@]host:path`. */
const REMOTE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_LIKE = /^(?:[^@/\\\s]+@)?[^/\\:\s]{2,}:(?!\/)/;

/**
 * Who can read a repository, from what an anonymous `git ls-remote` of it gave: it answered
 * (`public`, even empty), the host asked for credentials or hid it (`private`), or nothing can be
 * told (`unknown`: the network, a timeout, a server in trouble, a message not recognised). The
 * journal is not sent on a doubt. `lenient`, for a host that is not a forge's (a server of the
 * creator's own): any other failure means the repository cannot be read anonymously, which is
 * what private is. The addresses Git copies in its messages are left out first: a repository named
 * `tls-tools` or `app-500` is no sign of a network that is down.
 */
export function classifyAnonymousRead(
  run: Pick<GitRun, "status" | "stderr" | "timedOut">,
  options: { readonly lenient?: boolean } = {},
): RemoteExposure {
  if (run.status === 0) return "public";
  if (run.timedOut === true) return "unknown";
  const said = run.stderr.replace(/\S+:\/\/\S+/g, " ");
  if (STRONG_CREDENTIALS.test(said)) return "private";
  if (NETWORK_DOWN.test(said)) return "unknown";
  if (WEAK_CREDENTIALS.test(said)) return "private";
  return options.lenient === true ? "private" : "unknown";
}

/**
 * What an address is for the anonymous read: `local` (a path on a disk or a share, `file://`:
 * nobody on the Internet reads it), `unknown` (a place on another machine this engine cannot read
 * from the web: another port of a server that is no forge's, a path with signs it does not parse),
 * or the web address to ask, on the remote's host (`https`, or `http` when the remote is), the port
 * kept for a web address, never a credential.
 */
export function anonymousTargetOf(
  url: string,
):
  | { readonly kind: "local" }
  | { readonly kind: "unknown" }
  | { readonly kind: "web"; readonly url: string } {
  const text = url.trim();
  if (/^file:\/\//i.test(text)) return { kind: "local" };
  const remote = REMOTE_SCHEME.test(text) || SCP_LIKE.test(text);
  if (!remote) return { kind: "local" };
  const location = remoteLocation(text);
  if (location === undefined) return { kind: "unknown" };
  const web = /^https?:\/\//i.test(text);
  const scheme = /^http:\/\//i.test(text) ? "http" : "https";
  // The port of a web address is the web's; the port of an `ssh` one says nothing of it.
  const port = web ? (/^https?:\/\/(?:[^@/]*@)?[^/:]+(:\d+)/i.exec(text)?.[1] ?? "") : "";
  if (!web && /^[a-z+]+:\/\/(?:[^@/]*@)?[^/:]+:\d+\//i.test(text) && !forgeOfHost(location.host)) {
    return { kind: "unknown" };
  }
  return { kind: "web", url: `${scheme}://${location.host}${port}/${location.path}` };
}

/** The web address of an anonymous read, or undefined when there is none (`local`, `unknown`). */
export function anonymousUrlOf(url: string): string | undefined {
  const target = anonymousTargetOf(url);
  return target.kind === "web" ? target.url : undefined;
}

const WORST: Record<RemoteExposure, number> = { public: 2, unknown: 1, private: 0 };

/**
 * Whether the repository at `url` is readable by anyone (the journal is never sent
 * there): an anonymous `git ls-remote`, with no credential helper, no prompt, no password program
 * and no other transport than the web's, whether it answers. The tool of the forge is not needed,
 * nor any account. A remote that is not on a host is `private`. An address with several lines (more
 * than one push address) is as exposed as its most exposed one.
 */
export async function probeExposure(
  url: string,
  options: { readonly cwd: string; readonly timeoutMs?: number },
): Promise<RemoteExposure> {
  const addresses = url
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  let worst: RemoteExposure = "private";
  for (const address of addresses) {
    const found = await probeOne(address, options);
    if (WORST[found] > WORST[worst]) worst = found;
  }
  return worst;
}

async function probeOne(
  url: string,
  options: { readonly cwd: string; readonly timeoutMs?: number },
): Promise<RemoteExposure> {
  const target = anonymousTargetOf(url);
  if (target.kind === "local") return "private";
  if (target.kind === "unknown") return "unknown";
  const host = remoteLocation(url)?.host ?? "";
  let run: GitRun;
  try {
    run = await runGit(
      options.cwd,
      [
        "-c",
        "credential.helper=",
        "-c",
        "core.askPass=",
        "-c",
        "http.extraHeader=",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "protocol.http.allow=always",
        "ls-remote",
        "--heads",
        target.url,
        "HEAD",
      ],
      undefined,
      {
        LC_ALL: "C",
        LANGUAGE: "C",
        GCM_INTERACTIVE: "never",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
      },
      options.timeoutMs ?? EXPOSURE_TIMEOUT_MS,
    );
  } catch {
    return "unknown";
  }
  return classifyAnonymousRead(run, { lenient: forgeOfHost(host) === undefined });
}
