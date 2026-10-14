import type { RuleAction } from "@agentplugged/protocol";
import { claudeActionRules } from "../sync/rule-permissions.js";

/**
 * Whether a shell command falls under a high-risk rule, or fetches content from
 * outside the product. `check_action` and `record_external_read` check it again
 * after Claude Code's `if` condition: a hook firing on a command it could not read (a
 * here-document, a quoted string) never opens a checkpoint nor marks the session for a harmless
 * one, and a command a hook missed is still found.
 *
 * The command is read as a shell reads it (`subcommands`): split on `&&`, `||`, `;`, `|`, `&` and
 * line breaks that are not inside quotes, a comment or a here-document body, then each
 * subcommand is brought to the command it runs (`NAME=value` assignments, `sudo`, `timeout 5`,
 * `if`, `(`, `git -C dir` left out) and compared to each `Bash(…)` pattern of the rule (`*`
 * matches anything). What a shell would run is followed: `$(…)`, backticks, `<(…)`,
 * `bash -c "…"`, `eval`, a here-document or here-string a shell reads. Anything else a quote or
 * a here-document holds is data. The engine's own commands (`npx agentplugged …`) are never
 * gated. Best effort, like the rules: a program reached another way (a script written then run,
 * `python -c`) is not followed.
 */

/**
 * A `Bash(…)` pattern as a regular expression, anchored. Case-insensitive: a Windows shell reads
 * `GIT PUSH` and `Invoke-WebRequest` as it reads their lower-case forms, and a match
 * too many only adds a check.
 */
export function patternOf(rule: string): RegExp | undefined {
  const match = /^Bash\((.*)\)$/s.exec(rule);
  if (match === null) return undefined;
  const body = (match[1] ?? "")
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`, "si");
}

/**
 * The shell commands that fetch content from outside the product: their output is external
 * content. Claude Code's `PostToolUse` hooks fire on these patterns, and `record_external_read`
 * checks them again (`isNetworkCommand`).
 */
export const NETWORK_COMMANDS = [
  "Bash(curl*)",
  "Bash(wget*)",
  "Bash(gh *)",
  "Bash(git pull*)",
  "Bash(git fetch*)",
  "Bash(git clone*)",
  // PowerShell, the shell Antigravity runs its commands in on Windows.
  "Bash(Invoke-WebRequest*)",
  "Bash(Invoke-RestMethod*)",
  "Bash(iwr *)",
  "Bash(irm *)",
] as const;

/** How deep a command inside a command (`bash -c "…"`, `$(…)`) is followed. */
const MAX_DEPTH = 4;

/** A here-document's marker: `<<-'EOF'`, `<<EOF`. */
interface HeredocMarker {
  readonly delimiter: string;
  readonly dash: boolean;
  /** Quoted (`<<'EOF'`, `<<\EOF`): the body is not expanded. */
  readonly quoted: boolean;
  /** The index after the marker. */
  readonly end: number;
}

/**
 * The here-document marker that starts at `at` (the first `<` of `<<`), or undefined: a
 * here-string (`<<<`), an arithmetic shift (`((a<<1))`) and a marker without a word are not one.
 */
function readHeredocMarker(text: string, at: number): HeredocMarker | undefined {
  if (text[at] !== "<" || text[at + 1] !== "<" || text[at + 2] === "<") return undefined;
  let j = at + 2;
  const dash = text[j] === "-";
  if (dash) j++;
  while (text[j] === " " || text[j] === "\t") j++;
  let delimiter = "";
  let quoted = false;
  while (j < text.length && !/[\s;&|<>()]/.test(text[j] as string)) {
    const part = text[j] as string;
    if (part === "'" || part === '"') {
      quoted = true;
      const close = text.indexOf(part, j + 1);
      const stop = close === -1 ? text.length : close;
      delimiter += text.slice(j + 1, stop);
      j = stop + 1;
    } else if (part === "\\") {
      quoted = true;
      delimiter += text[j + 1] ?? "";
      j += 2;
    } else {
      delimiter += part;
      j++;
    }
  }
  if (delimiter === "" || /^\d+$/.test(delimiter)) return undefined;
  return { delimiter, dash, quoted, end: Math.min(j, text.length) };
}

/**
 * A here-document's body, from the start of its first line, and the index after its end. `found`
 * is false when no line holds the delimiter: it was no here-document (`(( x = 1 << n ))`), and
 * what follows is read as commands.
 */
function heredocBody(
  text: string,
  from: number,
  marker: HeredocMarker,
): { readonly body: string; readonly next: number; readonly found: boolean } {
  let body = "";
  let at = from;
  while (at < text.length) {
    const newline = text.indexOf("\n", at);
    const stop = newline === -1 ? text.length : newline;
    const line = text.slice(at, stop).replace(/\r$/, "");
    at = stop + 1;
    if ((marker.dash ? line.replace(/^\t+/, "") : line) === marker.delimiter) {
      return { body, next: Math.min(at, text.length), found: true };
    }
    body += `${line}\n`;
  }
  return { body, next: from, found: false };
}

/** The index of the closing quote of an ANSI-C string `$'…'` whose opening quote is at `at`. */
function ansiQuoteEnd(text: string, at: number): number {
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "'") return i;
  }
  return text.length - 1;
}

/**
 * The end of a `$(…)` that opens just before `from`: the index of its `)`, or -1. Quotes, nested
 * substitutions and here-document bodies (an apostrophe in a commit message) are skipped.
 */
function closingParen(text: string, from: number): number {
  let depth = 1;
  let quote: string | null = null;
  const pending: HeredocMarker[] = [];
  for (let i = from; i < text.length; i++) {
    const char = text[i] as string;
    const next = text[i + 1];
    if (quote === "'") {
      if (char === "'") quote = null;
    } else if (char === "\\") {
      i++;
    } else if (char === "$" && next === "(") {
      const end = closingParen(text, i + 2);
      if (end === -1) return -1;
      i = end;
    } else if (char === "`") {
      const end = text.indexOf("`", i + 1);
      if (end === -1) return -1;
      i = end;
    } else if (quote === '"') {
      if (char === '"') quote = null;
    } else if (char === "$" && next === "'") {
      i = ansiQuoteEnd(text, i + 1);
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "<" && next === "<") {
      const marker = readHeredocMarker(text, i);
      if (marker !== undefined) {
        pending.push(marker);
        i = marker.end - 1;
      } else if (text[i + 2] === "<") {
        i += 2;
      } else {
        i++;
      }
    } else if (char === "\n") {
      for (const marker of pending.splice(0)) {
        const found = heredocBody(text, i + 1, marker);
        if (found.found) i = found.next - 1;
      }
    } else if (char === "(") {
      depth++;
    } else if (char === ")" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** The commands inside `$(…)` and backticks of a text (a here-document body that expands). */
function substitutionsOf(text: string): string[] {
  const inner: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (char === "\\") {
      i++;
    } else if (char === "$" && text[i + 1] === "(") {
      const end = closingParen(text, i + 2);
      inner.push(text.slice(i + 2, end === -1 ? text.length : end));
      if (end === -1) break;
      i = end;
    } else if (char === "`") {
      const end = text.indexOf("`", i + 1);
      inner.push(text.slice(i + 1, end === -1 ? text.length : end));
      if (end === -1) break;
      i = end;
    }
  }
  return inner;
}

/** A shell that runs the text it is given (`bash -c "…"`, `eval …`, PowerShell, `cmd /c`). */
const SHELL_WRAPPERS = [
  /^(?:(?:sudo|env|time|nohup|command|exec)\s+(?:-\S+\s+)*)*(?:\S*[\\/])?(?:ba|z|da|k|a)?sh(?:\.exe)?\s+(?:-\S+\s+)*?-[A-Za-z]*c\s+([\s\S]+)$/,
  /^eval\s+([\s\S]+)$/,
  /^(?:\S*[\\/])?(?:pwsh|powershell)(?:\.exe)?\s+(?:\S+\s+)*?-(?:c|command)\s+([\s\S]+)$/i,
  /^(?:\S*[\\/])?cmd(?:\.exe)?\s+\/[ck]\s+([\s\S]+)$/i,
];

/** A shell that reads its script from its input (a here-document or a here-string). */
const SHELL_READER =
  /^(?:(?:sudo|env|time|nohup|command|exec)\s+)*(?:\S*[\\/])?(?:ba|z|da|k|a)?sh(?:\.exe)?(?:\s|$)/;

/** The script a wrapper is given: its first word when quoted (a redirection may follow), else all. */
function scriptArgument(argument: string): string {
  const first = argument[0];
  if (first !== '"' && first !== "'") return argument;
  for (let i = 1; i < argument.length; i++) {
    if (first === '"' && argument[i] === "\\") i++;
    else if (argument[i] === first) {
      const body = argument.slice(1, i);
      return first === '"' ? body.replaceAll('\\"', '"') : body;
    }
  }
  return argument.slice(1);
}

/** The scripts a subcommand runs through a shell: the text of `bash -c "…"`, `eval …`. */
function wrappedScripts(command: string): string[] {
  for (const wrapper of SHELL_WRAPPERS) {
    const argument = wrapper.exec(command)?.[1]?.trim();
    if (argument === undefined || argument === "") continue;
    return [scriptArgument(argument)];
  }
  return [];
}

/** Programs that only read or write text: a here-document given to one of them is data. */
const DATA_READER =
  /^(?:cat|tee|echo|printf|grep|egrep|fgrep|rg|sed|awk|wc|head|tail|sort|uniq|diff|patch|base64|tr|cut|less|more|nl|fold|jq)(?:\s|$)|^git\s+(?:commit|tag|notes)(?:\s|$)/;

/** The word that starts at `at` (quoted or not), unquoted. */
function wordAt(text: string, at: number): string {
  let i = at;
  while (text[i] === " " || text[i] === "\t") i++;
  const first = text[i];
  if (first === '"' || first === "'") {
    const close = text.indexOf(first, i + 1);
    return text.slice(i + 1, close === -1 ? text.length : close);
  }
  let end = i;
  while (end < text.length && !/[\s;&|<>()]/.test(text[end] as string)) end++;
  return text.slice(i, end);
}

/**
 * The commands of a script, outermost first, split as a shell does. A quoted string, a comment or
 * a here-document given to `cat` or `tee` is only data (`grep -n "a|npm install" f`,
 * `cat > f <<'EOF' … EOF`): it is never a command.
 */
function scanScript(script: string, depth: number, executes = false): string[] {
  const out: string[] = [];
  if (depth > MAX_DEPTH) return out;
  const pending: { readonly marker: HeredocMarker; readonly command: string; run: boolean }[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let quoteStart = 0;
  let extra: string[] = [];
  /** A command inside this one; `runs`: a shell runs it, so a here-document in it is commands. */
  const nested = (text: string, runs = executes) => {
    extra.push(...scanScript(text, depth + 1, runs));
  };
  /** A `case` branch label (`a) cmd`) starts the next command after `;;` or `case x in`. */
  let branch = false;
  const flush = () => {
    let command = current.trim();
    current = "";
    if (command !== "") {
      if (branch) command = command.replace(/^[^\s()'"]+\)\s+/, "");
      branch = /^case\s.*\sin$/.test(command);
      out.push(command);
      const run = commandOf(command);
      if (SHELL_READER.test(run)) for (const heredoc of pending) heredoc.run = true;
      for (const inner of wrappedScripts(run)) nested(inner, true);
    }
    out.push(...extra);
    extra = [];
  };
  for (let i = 0; i < script.length; i++) {
    const char = script[i] as string;
    const next = script[i + 1];
    if (quote === "'") {
      current += char;
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\") {
      if (next === "\n") current += " ";
      else current += char + (next ?? "");
      i++;
      continue;
    }
    if (char === "$" && next === "(") {
      const end = closingParen(script, i + 2);
      const stop = end === -1 ? script.length : end;
      nested(script.slice(i + 2, stop));
      current += script.slice(i, stop + 1);
      i = stop;
      continue;
    }
    if (char === "`") {
      const end = script.indexOf("`", i + 1);
      const stop = end === -1 ? script.length : end;
      nested(script.slice(i + 1, stop));
      current += script.slice(i, stop + 1);
      i = stop;
      continue;
    }
    if (quote === '"') {
      current += char;
      if (char === '"') quote = null;
      continue;
    }
    if (char === "$" && next === "'") {
      const stop = ansiQuoteEnd(script, i + 1);
      current += script.slice(i, stop + 1);
      i = stop;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoteStart = i;
      current += char;
      continue;
    }
    if (char === "#" && (current === "" || /\s$/.test(current))) {
      while (i + 1 < script.length && script[i + 1] !== "\n") i++;
      continue;
    }
    if ((char === "<" || char === ">") && next === "(") {
      const end = closingParen(script, i + 2);
      const stop = end === -1 ? script.length : end;
      nested(script.slice(i + 2, stop));
      current += script.slice(i, stop + 1);
      i = stop;
      continue;
    }
    if (char === "<" && next === "<") {
      const marker = readHeredocMarker(script, i);
      if (marker !== undefined) {
        pending.push({ marker, command: current.trim(), run: false });
        current += script.slice(i, marker.end);
        i = marker.end - 1;
        continue;
      }
      if (script[i + 2] === "<") {
        // A here-string: a shell reads the word that follows as a script.
        if (SHELL_READER.test(commandOf(current))) nested(wordAt(script, i + 3), true);
        current += "<<<";
        i += 2;
        continue;
      }
    }
    if (char === "\n" || char === "\r") {
      flush();
      if (char === "\n") {
        for (const heredoc of pending.splice(0)) {
          const { body, next: after, found } = heredocBody(script, i + 1, heredoc.marker);
          // No line holds the delimiter: it was no here-document, what follows is commands.
          if (!found) continue;
          const reader = commandOf(heredoc.command);
          if (executes || heredoc.run || SHELL_READER.test(reader) || !DATA_READER.test(reader)) {
            nested(body, true);
          } else if (!heredoc.marker.quoted)
            for (const inner of substitutionsOf(body)) nested(inner);
          i = after - 1;
        }
        flush();
      }
      continue;
    }
    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      flush();
      i++;
      continue;
    }
    if (char === "&") {
      const before = current.at(-1);
      if (before === ">" || before === "<" || next === ">") {
        current += char;
        continue;
      }
      flush();
      continue;
    }
    if (char === ";" || char === "|") {
      flush();
      // A here-document piped to another program (`cat <<EOF | psql`) is that program's input.
      if (char === "|") for (const heredoc of pending) heredoc.run = true;
      if (char === ";" && next === ";") {
        branch = true;
        i++;
      }
      continue;
    }
    current += char;
  }
  // A quote never closed: in doubt, what follows it is read as plain text too.
  if (quote !== null) {
    for (const part of script.slice(quoteStart).split(/&&|\|\||[;|&\r\n]/)) {
      if (part.trim() !== "") out.push(part.trim());
    }
  }
  flush();
  return out;
}

/** The text with its leading assignments left out: `A=1`, `A="x y"`, `A=$(echo a b)`. */
function withoutAssignments(command: string): string {
  let rest = command;
  for (;;) {
    const start = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(rest);
    if (start === null) return rest;
    let quote: string | null = null;
    let i = start[0].length;
    for (; i < rest.length; i++) {
      const char = rest[i] as string;
      if (quote === "'") {
        if (char === "'") quote = null;
      } else if (char === "\\") {
        i++;
      } else if (char === "$" && rest[i + 1] === "(") {
        const end = closingParen(rest, i + 2);
        if (end === -1) return rest;
        i = end;
      } else if (char === "`") {
        const end = rest.indexOf("`", i + 1);
        if (end === -1) return rest;
        i = end;
      } else if (quote === '"') {
        if (char === '"') quote = null;
      } else if (char === "'" || char === '"') {
        quote = char;
      } else if (/\s/.test(char)) {
        break;
      }
    }
    if (i >= rest.length) return rest;
    rest = rest.slice(i).trimStart();
  }
}

/** Words that only introduce the command that follows: `then`, `do`, `!`, `(`, `{`… */
const KEYWORD_PREFIX =
  /^(?:[!({]\s*|(?:then|do|else|elif|if|while|until)\s+|case\s+\S+\s+in\s+(?:[^\s()'"]+\)\s+)?|\d?(?:>>?|<)&?[^\s<>]+\s+)/;

/** Programs that run the command that follows, with their options (`sudo -u root`, `timeout 5`). */
const RUNNER_PREFIX =
  /^(?:time|nohup|command(?!\s+-\w*[vV])|exec|builtin|sudo|doas|nice|ionice|stdbuf|timeout|xargs|env)(?=\s)(?:\s+(?:-[ugChDRTU]\s+\S+|-[IiLnsPkd]\s+(?:\{\}|[A-Z]+|\d[\w.]*|\w+=\S+)|-\S+|\d[\w.]*|[A-Za-z_]\w*=\S*))*\s+(?=\S)/;

/** The program, without its usual directory, its quotes, a leading backslash or `.exe`. */
const PROGRAM_WORD =
  /^(["']?)(?:\/usr\/local\/bin\/|\/usr\/bin\/|\/bin\/|\/opt\/homebrew\/bin\/|\/usr\/sbin\/|\/sbin\/|\\)?([A-Za-z][\w.+-]*?)(?:\.exe)?\1(?=\s|$)/;

/** Git's global options, which come before the subcommand (`git -C dir pull`). */
const GIT_OPTIONS =
  /^git(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--(?:git-dir|work-tree|namespace|exec-path)(?:=\S+|\s+\S+)|--(?:no-pager|paginate|no-optional-locks|no-replace-objects|bare|literal-pathspecs)|-[Pp]))+(?=\s+\S)/;

/** The `)` or `}` that closes a group the command did not open (`(cd d && git push)`). */
function withoutClosers(command: string): string {
  let text = command;
  for (const [open, close] of [
    ["(", ")"],
    ["{", "}"],
  ] as const) {
    while (text.endsWith(close)) {
      const opens = text.split(open).length - 1;
      const closes = text.split(close).length - 1;
      if (closes <= opens) break;
      text = text.slice(0, -1).trimEnd();
    }
  }
  return text;
}

/**
 * The command a subcommand runs, with what introduces it left out: assignments, `if`, `then`,
 * `(`, `!`, `sudo`, `timeout 5`, `xargs`, a program's directory or quotes, git's global options.
 */
function commandOf(subcommand: string): string {
  let command = subcommand.trim();
  for (let round = 0; round < 8; round++) {
    const before = command;
    command = withoutAssignments(command).trim();
    command = command.replace(KEYWORD_PREFIX, "").trimStart();
    command = command.replace(RUNNER_PREFIX, "");
    command = command.replace(PROGRAM_WORD, "$2").replace(GIT_OPTIONS, "git");
    command = withoutClosers(command);
    if (command === before) break;
  }
  return command;
}

/**
 * The parts of a command line as the shell would run them, each as written (`raw`) and brought to
 * the command it runs (`command`, empty for an assignment or a closer alone): the installations read both,
 * to tell a plain `npm install` from one a prefix or a variable changes.
 */
export function scriptParts(command: string): { raw: string; command: string }[] {
  return scanScript(command, 0).map((raw) => ({ raw, command: commandOf(raw) }));
}

/** The subcommands of a command line, each brought to the command it runs. */
export function subcommands(command: string): string[] {
  return scanScript(command, 0)
    .map(commandOf)
    .filter((part) => part !== "");
}

/**
 * The engine run by a launcher: `npx [-y] agentplugged[@x] …`, `pnpm dlx`, `bunx`, the
 * `agentplugged` binary, or the creator's local build: `node <path>/bin.js` or
 * `main.js`, the path bare or quoted, with the slashes of either system.
 */
const ENGINE_COMMAND = new RegExp(
  [
    String.raw`^(?:npx(?:\s+(?:-y|--yes))?|pnpm\s+dlx|bunx)\s+agentplugged(?:@\S+)?(?:\s|$)`,
    String.raw`^agentplugged(?:\s|$)`,
    String.raw`^node\s+(?:"[^"]*[\\/](?:bin|main)\.js"|'[^']*[\\/](?:bin|main)\.js'|\S*[\\/](?:bin|main)\.js)(?:\s|$)`,
  ].join("|"),
);

/** True for a subcommand that runs the engine itself (`npx agentplugged docs check`). */
export function isEngineCommand(subcommand: string): boolean {
  return ENGINE_COMMAND.test(subcommand);
}

/** True when every subcommand of `command` runs the engine itself (and there is one). */
export function engineCommandOnly(command: string): boolean {
  const parts = subcommands(command);
  return parts.length > 0 && parts.every(isEngineCommand);
}

/** The program of a command line word: without its folder, its quotes, or an executable extension. */
function programForm(word: string): string {
  const name = word.split(/[\\/]/).pop() ?? word;
  return name.replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

/**
 * The forms of a subcommand a pattern is tried on: as written, and as a shell reads
 * it: each word unquoted (`git push origin 'main'`), the blanks between words one space (tabs,
 * runs of spaces), the program without its folder and its extension (`& 'C:\Program
 * Files\Git\cmd\git.exe' push origin main`). A rule written for the plain form (`Bash(git push *
 * main)`) then holds for these spellings too. A text that a quote left unbalanced has the one form.
 */
export function commandForms(part: string): string[] {
  const words: string[] = [];
  const word = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let match = word.exec(part); match !== null; match = word.exec(part)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  const [program, ...rest] = words;
  if (program === undefined) return [part];
  const plain = [programForm(program), ...rest].join(" ");
  return plain === part ? [part] : [part, plain];
}

/** True when one of the forms of `part` is matched by one of `patterns`. */
export function matchesAny(part: string, patterns: readonly RegExp[]): boolean {
  return commandForms(part).some((form) => patterns.some((pattern) => pattern.test(form)));
}

/** A subcommand with its runs of white space as one space (`npm  install x` is `npm install x`). */
const squeezed = (part: string) => part.replace(/[ \t]+/g, " ");

/**
 * True when one subcommand of `command`, other than the engine's own, matches one of `rule`'s
 * patterns. `mainBranch` is the product's main branch, as `sync` writes the hooks with it.
 */
export function commandMatches(rule: RuleAction, command: string, mainBranch?: string): boolean {
  const patterns = claudeActionRules(rule, mainBranch)
    .map(patternOf)
    .filter((pattern): pattern is RegExp => pattern !== undefined);
  return subcommands(command)
    .filter((part) => !isEngineCommand(part))
    .map(squeezed)
    .some((part) => matchesAny(part, patterns));
}

/**
 * True when one subcommand of `command`, other than the engine's own, fetches content from
 * outside the product (`curl`, `wget`, `gh`, `git pull`/`fetch`/`clone`). A command that only
 * writes or reads local files (`cat > f <<'EOF' …`, `sed -n 60,80p f`, `grep -rn x .`) is not an
 * external read, whatever words its text or its here-document body holds.
 */
export function isNetworkCommand(command: string): boolean {
  const patterns = NETWORK_COMMANDS.map(patternOf).filter(
    (pattern): pattern is RegExp => pattern !== undefined,
  );
  return subcommands(command)
    .filter((part) => !isEngineCommand(part))
    .some((part) => matchesAny(part, patterns));
}
