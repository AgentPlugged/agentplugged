import { type FileWords, WordTable, wordsOf } from "./tokens.js";

/**
 * The duplicate detector: deterministic, no AI, no dependency. Each file
 * becomes normalised words (`tokens.ts`); a rolling hash gives the fingerprint of every run of
 * `GRAM` words; winnowing keeps the smallest fingerprint of every window of `window` of them, so
 * that any run of `minTokens` words shared by two places shares at least one kept fingerprint.
 * The kept fingerprints of the whole repository are indexed; those of the added lines are looked
 * up; every pair found is checked word by word and extended both ways into the whole shared block.
 * A block is a duplicate when it is at least `minTokens` words and a few lines long, with enough
 * different words (a table of values or a row of closing brackets is not one).
 */

/** A file as the detector reads it: its path and its text. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** Where a duplicate stands: a file and its lines. */
export interface Place {
  readonly path: string;
  readonly from: number;
  readonly to: number;
}

/** Two places that hold the same code (renamed or not), `here` being the one the change added. */
export interface Duplicate {
  readonly here: Place;
  readonly there: Place;
  /** Words in common. */
  readonly tokens: number;
  /** Other places that hold the same block, not listed. */
  readonly others: number;
}

export interface DetectOptions {
  /** Words a block must share to be a duplicate. Default `DEFAULT_MIN_TOKENS`. */
  readonly minTokens?: number;
  /** Longest the run may take, in milliseconds; beyond, what was found is returned as `partial`. */
  readonly maxMs?: number;
  /** The clock (milliseconds); the tests give theirs. */
  readonly clock?: () => number;
}

export interface Detection {
  readonly duplicates: readonly Duplicate[];
  /** The time ran out before the whole repository was read. */
  readonly partial: boolean;
  readonly files: number;
  readonly tokens: number;
}

/** About five to eight lines of code. Below, similar code is just similar (a signature, a loop). */
export const DEFAULT_MIN_TOKENS = 50;
/** Words in a fingerprint. */
export const GRAM = 10;
/** A duplicate spans at least this many lines, with at least this many different words. */
export const MIN_LINES = 4;
export const MIN_DISTINCT = 14;
/** Past this many places for one fingerprint, it is boilerplate, not a copy: not indexed more. */
export const MAX_OCCURRENCES = 64;
export const DEFAULT_MAX_MS = 20_000;
const MAX_BLOCKS = 500;

const BASE = 1_000_003;

function mix(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The kept fingerprints of a file: winnowing over the rolling hashes of its runs of `gram` words. */
export function fingerprints(
  ids: Uint32Array,
  gram: number,
  window: number,
): { hashes: Uint32Array; positions: Uint32Array } {
  const runs = ids.length - gram + 1;
  if (runs < 1) return { hashes: new Uint32Array(0), positions: new Uint32Array(0) };
  let top = 1;
  for (let i = 1; i < gram; i += 1) top = Math.imul(top, BASE);
  const hashes = new Uint32Array(runs);
  let rolling = 0;
  for (let i = 0; i < gram; i += 1) rolling = (Math.imul(rolling, BASE) + (ids[i] as number)) | 0;
  hashes[0] = mix(rolling);
  for (let i = 1; i < runs; i += 1) {
    const out = Math.imul(ids[i - 1] as number, top);
    rolling = (Math.imul((rolling - out) | 0, BASE) + (ids[i + gram - 1] as number)) | 0;
    hashes[i] = mix(rolling);
  }
  const keptHashes: number[] = [];
  const keptPositions: number[] = [];
  const size = Math.min(window, runs);
  // A queue of positions whose hashes grow: the front is the smallest (the rightmost on a tie).
  const queue = new Int32Array(runs);
  let head = 0;
  let tail = 0;
  let last = -1;
  for (let i = 0; i < runs; i += 1) {
    while (tail > head && (hashes[queue[tail - 1] as number] as number) >= (hashes[i] as number)) {
      tail -= 1;
    }
    queue[tail] = i;
    tail += 1;
    if ((queue[head] as number) <= i - size) head += 1;
    if (i >= size - 1) {
      const chosen = queue[head] as number;
      if (chosen !== last) {
        keptHashes.push(hashes[chosen] as number);
        keptPositions.push(chosen);
        last = chosen;
      }
    }
  }
  return { hashes: Uint32Array.from(keptHashes), positions: Uint32Array.from(keptPositions) };
}

interface Indexed {
  readonly path: string;
  readonly words: FileWords;
  readonly added: ReadonlySet<number> | undefined;
  readonly hashes: Uint32Array;
  readonly positions: Uint32Array;
}

interface Block {
  readonly fa: number;
  readonly a: number;
  readonly fb: number;
  readonly b: number;
  readonly length: number;
  readonly addedA: number;
  readonly addedB: number;
}

function addedIn(file: Indexed, start: number, length: number): number {
  if (file.added === undefined) return 0;
  let count = 0;
  for (let i = start; i < start + length; i += 1) {
    if (file.added.has(file.words.lines[i] as number)) count += 1;
  }
  return count;
}

function distinctIn(ids: Uint32Array, start: number, length: number): number {
  const seen = new Set<number>();
  for (let i = start; i < start + length; i += 1) seen.add(ids[i] as number);
  return seen.size;
}

/**
 * The duplicates of the added code (`added`: the added lines of each file, by path) among `files`,
 * the files of the repository as the change leaves it. A block counts when the change added enough
 * of one of its two places. Deterministic: the same files give the same duplicates, in the same
 * order (longest first), unless the time ran out (`partial`).
 */
export function detectDuplicates(
  files: readonly SourceFile[],
  added: ReadonlyMap<string, ReadonlySet<number>>,
  options: DetectOptions = {},
): Detection {
  const minTokens = Math.max(2, options.minTokens ?? DEFAULT_MIN_TOKENS);
  const gram = Math.min(GRAM, minTokens);
  const window = Math.max(1, minTokens - gram + 1);
  const clock = options.clock ?? Date.now;
  const deadline = clock() + (options.maxMs ?? DEFAULT_MAX_MS);
  let partial = false;
  const timeUp = () => {
    if (!partial && clock() > deadline) partial = true;
    return partial;
  };

  const table = new WordTable();
  const indexed: Indexed[] = [];
  const index = new Map<number, number[]>();
  let tokens = 0;
  // The files the change touched are read first: a time limit never leaves them out.
  const ordered = [...files].sort((x, y) => Number(added.has(y.path)) - Number(added.has(x.path)));
  for (const file of ordered) {
    if (timeUp()) break;
    const words = wordsOf(file.path, file.text, table);
    if (words.ids.length < minTokens) continue;
    tokens += words.ids.length;
    const print = fingerprints(words.ids, gram, window);
    const at = indexed.length;
    indexed.push({ path: file.path, words, added: added.get(file.path), ...print });
    for (let i = 0; i < print.hashes.length; i += 1) {
      const hash = print.hashes[i] as number;
      const places = index.get(hash);
      if (places === undefined) index.set(hash, [at, print.positions[i] as number]);
      else if (places.length < MAX_OCCURRENCES * 2) places.push(at, print.positions[i] as number);
    }
  }

  const blocks: Block[] = [];
  const covered = new Map<string, [number, number][]>();
  const seen = new Set<string>();
  let work = 0;
  for (let f = 0; f < indexed.length && !timeUp(); f += 1) {
    const file = indexed[f] as Indexed;
    if (file.added === undefined || file.added.size === 0) continue;
    for (let i = 0; i < file.hashes.length; i += 1) {
      const pos = file.positions[i] as number;
      if (!file.added.has(file.words.lines[pos] as number)) continue;
      const places = index.get(file.hashes[i] as number) ?? [];
      for (let p = 0; p < places.length; p += 2) {
        // Periodic code (tables, generated data) makes many candidates: the clock is read often.
        work += 1;
        if (work % 64 === 0 && timeUp()) break;
        const g = places[p] as number;
        const q = places[p + 1] as number;
        if (g === f && q === pos) continue;
        const other = indexed[g] as Indexed;
        const key = `${f}:${g}:${pos - q}`;
        const done = covered.get(key);
        if (done?.some(([from, to]) => pos >= from && pos < to) === true) continue;
        // The fingerprint may collide: the words are compared.
        let same = true;
        for (let k = 0; k < gram && same; k += 1) {
          same = file.words.ids[pos + k] === other.words.ids[q + k];
        }
        if (!same) continue;
        let a = pos;
        let b = q;
        while (a > 0 && b > 0 && file.words.ids[a - 1] === other.words.ids[b - 1]) {
          a -= 1;
          b -= 1;
        }
        let ea = pos + gram;
        let eb = q + gram;
        while (
          ea < file.words.ids.length &&
          eb < other.words.ids.length &&
          file.words.ids[ea] === other.words.ids[eb]
        ) {
          ea += 1;
          eb += 1;
        }
        let length = ea - a;
        if (g === f) {
          const apart = Math.abs(a - b);
          if (apart === 0) continue;
          length = Math.min(length, apart);
        }
        const interval: [number, number] = [a, a + length];
        covered.set(key, [...(done ?? []), interval]);
        if (length < minTokens) continue;
        const firstLine = file.words.lines[a] as number;
        const lastLine = file.words.lines[a + length - 1] as number;
        if (lastLine - firstLine + 1 < MIN_LINES) continue;
        if (distinctIn(file.words.ids, a, length) < MIN_DISTINCT) continue;
        const addedA = addedIn(file, a, length);
        const addedB = g === f && b === a ? 0 : addedIn(other, b, length);
        if (Math.max(addedA, addedB) < Math.ceil(minTokens / 2)) continue;
        // The same pair seen from its other end counts once.
        const ends = [`${f}:${a}`, `${g}:${b}`].sort().join("|");
        const identity = `${ends}:${length}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        blocks.push({ fa: f, a, fb: g, b, length, addedA, addedB });
        if (blocks.length >= MAX_BLOCKS) break;
      }
      if (blocks.length >= MAX_BLOCKS) break;
    }
    if (blocks.length >= MAX_BLOCKS) break;
  }

  // Each block is told from the side the change added most (a tie: the first path), then blocks of
  // one place are one duplicate, the other places counted.
  const oriented = blocks.map((block) => {
    const swap =
      block.addedB > block.addedA ||
      (block.addedB === block.addedA &&
        (indexed[block.fb] as Indexed).path < (indexed[block.fa] as Indexed).path);
    return swap
      ? { fa: block.fb, a: block.b, fb: block.fa, b: block.a, length: block.length }
      : { fa: block.fa, a: block.a, fb: block.fb, b: block.b, length: block.length };
  });
  oriented.sort(
    (x, y) =>
      y.length - x.length ||
      (indexed[x.fa] as Indexed).path.localeCompare((indexed[y.fa] as Indexed).path) ||
      x.a - y.a ||
      (indexed[x.fb] as Indexed).path.localeCompare((indexed[y.fb] as Indexed).path) ||
      x.b - y.b,
  );
  const duplicates: (Duplicate & { fa: number; a: number; end: number })[] = [];
  for (const block of oriented) {
    const home = duplicates.find(
      (kept) =>
        kept.fa === block.fa &&
        Math.min(kept.end, block.a + block.length) - Math.max(kept.a, block.a) >=
          Math.min(kept.tokens, block.length) / 2,
    );
    if (home !== undefined) {
      (home as { others: number }).others += 1;
      continue;
    }
    const here = indexed[block.fa] as Indexed;
    const there = indexed[block.fb] as Indexed;
    const placeOf = (file: Indexed, start: number, onAdded = false): Place => {
      let first = start;
      // The place told for the change starts at its first added line (a comment on it can be posted).
      if (onAdded && file.added !== undefined) {
        while (
          first < start + block.length - 1 &&
          !file.added.has(file.words.lines[first] as number)
        ) {
          first += 1;
        }
      }
      return {
        path: file.path,
        from: file.words.lines[first] as number,
        to: file.words.lines[start + block.length - 1] as number,
      };
    };
    duplicates.push({
      here: placeOf(here, block.a, true),
      there: placeOf(there, block.b),
      tokens: block.length,
      others: 0,
      fa: block.fa,
      a: block.a,
      end: block.a + block.length,
    });
  }
  return {
    duplicates: duplicates.map(({ here, there, tokens: shared, others }) => ({
      here,
      there,
      tokens: shared,
      others,
    })),
    partial,
    files: indexed.length,
    tokens,
  };
}
