import type { CiForge, CiUnavailableReason } from "@agentplugged/protocol";

/** One check of a pull request, as the forge reports it, reduced to what the engine needs. */
export interface CiCheck {
  readonly name: string;
  /**
   * `pass` (passed, skipped, an optional manual job), `fail` (failed, cancelled) or `pending`
   * (queued, running, a manual job that blocks).
   */
  readonly state: "pass" | "fail" | "pending";
}

/** The repository as the CI sees it. */
export interface CiRepository {
  /** The forge of the `origin` remote, or null when it is neither GitHub nor GitLab. */
  readonly forge: CiForge | null;
  /** The workspace's folder inside the repository (`""` at its top, else `app/`). */
  readonly prefix: string;
  /** The main branch's short name (`main`), or null when none is found. */
  readonly main: string | null;
  /**
   * The CI files at the repository's top (`CI_CONFIG_PATHS`, the workflows directly in
   * `.github/workflows/`), whatever folder the workspace is in.
   */
  readonly ci: readonly string[];
}

/** Why the forge could not give the checks. */
export type CiReadFailure = Extract<
  CiUnavailableReason,
  | "forge_cli_missing"
  | "not_authenticated"
  | "no_pull_request"
  | "forge_failed"
  | "forge_timeout"
  | "forge_access"
>;

/** The checks of a branch's open pull request, or why they could not be read. */
export type CiReading =
  | {
      readonly ok: true;
      readonly checks: readonly CiCheck[];
      /** The pull request's number and address, when the forge gives them. */
      readonly pr?: number;
      readonly url?: string;
      /** The commit the checks ran on. */
      readonly commit?: string;
      /**
       * The forge says the pull request conflicts with its target: a CI that triggers on
       * pull requests does not start on it until the creator resolves the conflict on the forge.
       */
      readonly conflicting?: true;
    }
  | {
      readonly ok: false;
      readonly reason: CiReadFailure;
      /** The forge's tool (`gh`, `glab`). */
      readonly tool: string;
      /** The first line of the tool's error. */
      readonly detail?: string;
    };

/**
 * Port through which core reads a story's CI: the repository (forge, folder, CI
 * files), then the checks of a branch's open pull request through the forge's command-line tool
 * (`gh`, `glab`), already signed in by the creator. Read only: never a token, never a free API
 * call, never a write.
 */
export interface CiReader {
  /** The repository holding the workspace, or null outside one. */
  repository(): Promise<CiRepository | null>;
  /** The checks of the open pull request whose source branch is `branch`, on `forge`. */
  read(branch: string, forge: CiForge): Promise<CiReading>;
}
