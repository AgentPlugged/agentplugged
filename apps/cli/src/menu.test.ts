import { PassThrough } from "node:stream";
import { AgentPluggedError } from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { canDrawMenus, createMenu, GoBack } from "./menu.js";
import { askYesNo, chooseMany, chooseOne, createPrompter } from "./prompt.js";

/** A terminal that can be typed on: both ends claim to be terminals, the keys come from the test. */
function terminal() {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(mode: boolean): PassThrough;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode;
    return input;
  };
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = 100;
  output.rows = 30;
  let drawn = "";
  output.on("data", (chunk: Buffer) => {
    drawn += chunk.toString("utf8");
  });
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
  return {
    input,
    output,
    drawn: () => drawn,
    /** Types the keys one by one, each once the menu has stopped drawing. */
    async press(...keys: string[]) {
      for (const key of keys) {
        let last = -1;
        for (let waited = 0; waited < 3000; waited += 25) {
          await wait(25);
          if (drawn.length > 0 && drawn.length === last) break;
          last = drawn.length;
        }
        input.write(key);
      }
    },
  };
}

const DOWN = "\u001b[B";
const UP = "\u001b[A";
const ENTER = "\r";
const SPACE = " ";
const ESCAPE = "\u001b";
const CTRL_C = "\u0003";

const OPTIONS = [
  { label: "First", hint: "the first one" },
  { label: "Second", hint: "the second one" },
  { label: "Third" },
];

describe("menus in a terminal", () => {
  it("move with the arrows and validate with Enter, the recommended one being under the cursor", async () => {
    const term = terminal();
    const menu = createMenu(term.input, term.output);
    const kept = menu.select("Pick one", OPTIONS, 1);
    await term.press(ENTER);
    expect(await kept).toBe(1);
    const moved = menu.select("Pick one", OPTIONS, 0);
    await term.press(DOWN, DOWN, UP, ENTER);
    expect(await moved).toBe(1);
    expect(term.drawn()).toContain("Pick one");
    expect(term.drawn()).toContain("First");
  });

  it("ticks with space and needs at least one", async () => {
    const term = terminal();
    const menu = createMenu(term.input, term.output);
    const picked = menu.multiselect("Pick some", OPTIONS, [0]);
    await term.press(DOWN, SPACE, ENTER);
    expect(await picked).toEqual([0, 1]);
    const none = menu.multiselect("Pick some", OPTIONS, []);
    // Enter with nothing ticked is refused (at least one), then a tick and Enter.
    await term.press(ENTER, SPACE, ENTER);
    expect(await none).toEqual([0]);
  });

  it("answers yes or no with the keys y and n", async () => {
    const term = terminal();
    const menu = createMenu(term.input, term.output);
    const yes = menu.confirm("Do it?", false);
    await term.press("y");
    expect(await yes).toBe(true);
    const no = menu.confirm("Do it?", true);
    await term.press("n");
    expect(await no).toBe(false);
    const kept = menu.confirm("Do it?", true);
    await term.press(ENTER);
    expect(await kept).toBe(true);
  });

  it("goes back with Escape and leaves with Ctrl+C", async () => {
    const term = terminal();
    const menu = createMenu(term.input, term.output);
    const back = menu.select("Pick one", OPTIONS, 0);
    const caught = back.catch((error: unknown) => error);
    await term.press(ESCAPE);
    expect(await caught).toBeInstanceOf(GoBack);
    const leave = menu.select("Pick one", OPTIONS, 0).catch((error: unknown) => error);
    await term.press(CTRL_C);
    const error = await leave;
    expect(error).toBeInstanceOf(AgentPluggedError);
    expect((error as AgentPluggedError).code).toBe(ErrorCode.CANCELLED);
  });

  it("gives the terminal back to the line questions as it found it", async () => {
    const term = terminal();
    const lines: string[] = [];
    const prompter = createPrompter(
      term.input,
      (text) => lines.push(text),
      createMenu(term.input, term.output),
    );
    const t = createTranslator("en");
    // A line before, a menu, a line after: the keys of the menu are never taken for lines.
    term.input.write("before\n");
    expect(await prompter.ask("Name: ")).toBe("before");
    const index = chooseOne(t, prompter, {
      title: "Pick one",
      options: OPTIONS,
      question: () => "never asked in a terminal",
      fallback: 0,
    });
    await term.press(DOWN, ENTER);
    expect(await index).toBe(1);
    expect(term.input.isRaw).toBe(false);
    term.input.write("after\n");
    expect(await prompter.ask("Name: ")).toBe("after");
    prompter.close();
  });

  it("is what chooseOne, chooseMany and askYesNo use instead of the numbered questions", async () => {
    const term = terminal();
    const prompter = createPrompter(term.input, () => {}, createMenu(term.input, term.output));
    const t = createTranslator("en");
    const many = chooseMany(t, prompter, {
      title: "Tools",
      options: OPTIONS,
      question: () => "numbers: ",
      fallback: [0, 2],
    });
    await term.press(ENTER);
    expect(await many).toEqual([0, 2]);
    const yes = askYesNo(t, prompter, "Write the files now? (Y/n) ", true);
    await term.press(ENTER);
    expect(await yes).toBe(true);
    // The question is shown without the « (Y/n) » the menu replaces.
    expect(term.drawn()).toContain("Write the files now?");
    expect(term.drawn()).not.toContain("(Y/n)");
    prompter.close();
  });
});

describe("when a menu can be drawn", () => {
  const tty = (value: boolean) => ({ isTTY: value, setRawMode: () => undefined }) as never;
  it("needs a terminal at both ends, a real terminal type, and no refusal", () => {
    const out = { isTTY: true } as never;
    expect(canDrawMenus(tty(true), out, {})).toBe(true);
    expect(canDrawMenus(tty(false), out, {})).toBe(false);
    expect(canDrawMenus(tty(true), { isTTY: false } as never, {})).toBe(false);
    expect(canDrawMenus(tty(true), undefined, {})).toBe(false);
    expect(canDrawMenus(tty(true), out, { TERM: "dumb" })).toBe(false);
    expect(canDrawMenus(tty(true), out, { AGENTPLUGGED_MENUS: "off" })).toBe(false);
    expect(canDrawMenus({} as never, out, {})).toBe(false);
  });
});
