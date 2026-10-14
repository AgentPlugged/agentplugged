import type { ProofRunRequest, ProofRunResult } from "../proofs/proof-runner.js";
import type { CopyOpening, MutationCopy, MutationLab } from "../quality/mutation-run.js";

/**
 * A lab of memory for the tests of the mutation check: the "copy" is a map of files
 * handed over by copy, never by reference, and the "tests" are a function of the files of the copy.
 */

export const passed = (): ProofRunResult => ({
  ended: "exit",
  exit: 0,
  ms: 1200,
  head: "",
  tail: "2 passed",
  omitted: 0,
});
export const failed = (tail = "1 failed"): ProofRunResult => ({ ...passed(), exit: 1, tail });

/** What the tests of this world pin down: a function of the files of the copy. */
export type Tests = (
  files: ReadonlyMap<string, string>,
  request: ProofRunRequest,
) => ProofRunResult;

export class FakeCopy implements MutationCopy {
  readonly writes: Array<{ path: string; text: string }> = [];
  readonly requests: ProofRunRequest[] = [];
  closed = false;
  failWrites: ((path: string, text: string, count: number) => boolean) | undefined;
  leftover: string | undefined;
  readonly runner: MutationCopy["runner"];

  constructor(
    readonly files: Map<string, string>,
    tests: Tests,
    private readonly clock: { advance(ms: number): void },
    private readonly spent: number,
  ) {
    this.runner = {
      run: async (request) => {
        this.requests.push(request);
        this.clock.advance(this.spent);
        return tests(this.files, request);
      },
    };
  }

  async read(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async write(path: string, text: string): Promise<void> {
    this.writes.push({ path, text });
    if (this.failWrites?.(path, text, this.writes.length) === true) throw new Error("disk full");
    this.files.set(path, text);
  }

  async close(): Promise<string | undefined> {
    this.closed = true;
    return this.leftover;
  }
}

export class FakeLab implements MutationLab {
  readonly opened: FakeCopy[] = [];
  openings = 0;
  refuse: string | undefined;
  throws = false;
  failWrites: FakeCopy["failWrites"];
  leftover: string | undefined;

  constructor(
    /** The creator's folder: handed over by copy, never by reference. */
    readonly creator: Map<string, string>,
    private readonly tests: Tests,
    private readonly clock: { advance(ms: number): void },
    private readonly spent = 1000,
  ) {}

  async open(): Promise<CopyOpening> {
    this.openings += 1;
    if (this.throws) throw new Error("no room left");
    if (this.refuse !== undefined) return { refused: this.refuse };
    const copy = new FakeCopy(new Map(this.creator), this.tests, this.clock, this.spent);
    copy.failWrites = this.failWrites;
    copy.leftover = this.leftover;
    this.opened.push(copy);
    return { copy };
  }
}
