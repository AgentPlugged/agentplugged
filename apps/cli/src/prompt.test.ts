import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createPrompter } from "./prompt.js";

/** A stream that says it is a terminal, with a raw mode the test can watch. */
function fakeTty() {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode: (mode: boolean) => void;
  };
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = vi.fn((mode: boolean) => {
    stream.isRaw = mode;
  });
  return stream;
}

describe("waitCancel in a terminal", () => {
  it("cancels on a, alone, and restores the raw mode", async () => {
    const tty = fakeTty();
    const prompter = createPrompter(tty, () => {});
    const waiting = prompter.waitCancel(5_000, "a");
    tty.write("a");
    expect(await waiting).toBe(true);
    expect(tty.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(tty.setRawMode).toHaveBeenLastCalledWith(false);
    expect(tty.isRaw).toBe(false);
    prompter.close();
  });

  it("cancels on A and on Ctrl+C", async () => {
    for (const key of ["A", "\u0003"]) {
      const tty = fakeTty();
      const prompter = createPrompter(tty, () => {});
      const waiting = prompter.waitCancel(5_000, "a");
      tty.write(key);
      expect(await waiting).toBe(true);
      prompter.close();
    }
  });

  it("ignores other keys, arrows and pasted text, then ends at the timeout", async () => {
    const tty = fakeTty();
    const prompter = createPrompter(tty, () => {});
    const waiting = prompter.waitCancel(150, "a");
    for (const chunk of ["b", "\u001b[A", "a bit of pasted text", "aa"]) tty.write(chunk);
    expect(await waiting).toBe(false);
    expect(tty.isRaw).toBe(false);
    prompter.close();
  });

  it("keeps a raw mode that was on before", async () => {
    const tty = fakeTty();
    tty.isRaw = true;
    const prompter = createPrompter(tty, () => {});
    expect(await prompter.waitCancel(20, "a")).toBe(false);
    expect(tty.setRawMode).toHaveBeenLastCalledWith(true);
    prompter.close();
  });

  it("does not feed the window's keys to the next question", async () => {
    const tty = fakeTty();
    const prompter = createPrompter(tty, () => {});
    const waiting = prompter.waitCancel(100, "a");
    tty.write("zz");
    expect(await waiting).toBe(false);
    const answer = prompter.ask("? ");
    tty.write("yes\n");
    expect(await answer).toBe("yes");
    prompter.close();
  });
});

describe("askSecret", () => {
  it("reads a passphrase in a terminal without echoing it, then restores the raw mode", async () => {
    const tty = fakeTty();
    let written = "";
    const prompter = createPrompter(tty, (text) => {
      written += text;
    });
    const asked = prompter.askSecret("Passphrase: ");
    for (const chunk of ["une phrase", "\u001b[A", "x\u007f de passe", "\r"]) tty.write(chunk);
    expect(await asked).toBe("une phrase de passe");
    expect(written).toBe("Passphrase: \n");
    expect(tty.isRaw).toBe(false);
    // The next question reads the next line, not the passphrase's keys.
    const answer = prompter.ask("? ");
    tty.write("yes\n");
    expect(await answer).toBe("yes");
    prompter.close();
  });

  it("drops escape sequences inside a chunk and across chunks, keeps a bracketed paste", async () => {
    const tty = fakeTty();
    const prompter = createPrompter(tty, () => {});
    const asked = prompter.askSecret("Passphrase: ");
    for (const chunk of [
      "ab\u001b[1;5Dc", // Ctrl+Left in the middle of a chunk
      "\u001b", // an escape split across chunks…
      "[Bd\u001bOPe", // …then its end, and F1 (SS3)
      "\u001b[200~collé\r\nici\u001b[201~", // a bracketed paste, line break dropped
      "f\u001bxg", // Alt+x
    ]) {
      tty.write(chunk);
    }
    tty.write("\r");
    expect(await asked).toBe("abcdecolléicifg");
    prompter.close();
  });

  it("hands what follows Enter back to the next question", async () => {
    const tty = fakeTty();
    const prompter = createPrompter(tty, () => {});
    const asked = prompter.askSecret("Passphrase: ");
    tty.write("secret\r\nyes\n");
    expect(await asked).toBe("secret");
    expect(await prompter.ask("? ")).toBe("yes");
    prompter.close();
  });

  it("resolves undefined when the input ends", async () => {
    const tty = fakeTty();
    const prompter = createPrompter(tty, () => {});
    const asked = prompter.askSecret("Passphrase: ");
    tty.write("abc");
    tty.end();
    expect(await asked).toBeUndefined();
    expect(tty.isRaw).toBe(false);
    prompter.close();
  });

  it("is cancelled by Ctrl+C", async () => {
    const tty = fakeTty();
    const prompter = createPrompter(tty, () => {});
    const asked = prompter.askSecret("Passphrase: ");
    tty.write("abc\u0003");
    expect(await asked).toBeUndefined();
    prompter.close();
  });

  it("reads a line without a terminal", async () => {
    const input = new PassThrough();
    const prompter = createPrompter(input, () => {});
    const asked = prompter.askSecret("Passphrase: ");
    input.write("une phrase de passe\n");
    expect(await asked).toBe("une phrase de passe");
    prompter.close();
  });
});

describe("waitCancel without a terminal", () => {
  it("cancels on a line holding a, and lets the window run out otherwise", async () => {
    const input = new PassThrough();
    const prompter = createPrompter(input, () => {});
    const waiting = prompter.waitCancel(5_000, "a");
    input.write("a\n");
    expect(await waiting).toBe(true);
    expect(await prompter.waitCancel(30, "a")).toBe(false);
    prompter.close();
  });
});
