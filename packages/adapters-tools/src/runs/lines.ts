import { StringDecoder } from "node:string_decoder";

/**
 * Cuts a byte stream into lines: UTF-8 decoded so that a character split between two chunks stays
 * whole, any of `\n` and `\r\n` ends a line, and a line longer than `maxLine` characters is
 * dropped whole (its end is skipped up to the next line break) rather than kept in memory.
 */
export class LineSplitter {
  readonly #decoder = new StringDecoder("utf8");
  readonly #maxLine: number;
  #pending = "";
  #skipping = false;
  /** How many lines were dropped for being too long. */
  dropped = 0;

  constructor(maxLine = 16 * 1024 * 1024) {
    this.#maxLine = maxLine;
  }

  /** The complete lines a chunk finishes. */
  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    return this.#cut(text);
  }

  /** The last line, when the stream ended without a line break. */
  end(): string[] {
    const rest = this.#cut(this.#decoder.end());
    if (!this.#skipping && this.#pending.trim() !== "") rest.push(this.#pending);
    this.#pending = "";
    this.#skipping = false;
    return rest;
  }

  #cut(text: string): string[] {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) break;
      const piece = text.slice(start, newline);
      start = newline + 1;
      if (this.#skipping) {
        this.#skipping = false;
        this.#pending = "";
        continue;
      }
      const line = (this.#pending + piece).replace(/\r$/, "");
      this.#pending = "";
      if (line.length > this.#maxLine) this.dropped += 1;
      else if (line.trim() !== "") lines.push(line);
    }
    const tail = text.slice(start);
    if (!this.#skipping) {
      this.#pending += tail;
      if (this.#pending.length > this.#maxLine) {
        this.#pending = "";
        this.#skipping = true;
        this.dropped += 1;
      }
    }
    return lines;
  }
}
