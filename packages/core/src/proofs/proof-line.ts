/**
 * How the engine reads a command line of the project. A line made of a program and
 * its arguments is started directly, without a shell: what the creator read is what runs, and a
 * file name or a quote cannot become a command. A line that uses the shell's own syntax (a pipe, a
 * redirection, `&&`, `$VAR`, a glob outside quotes, a variable set before the program) cannot be
 * split into arguments: it is started through the system's shell, and the accord says so.
 */

/** The line as arguments, or `shell` when it needs the shell's syntax, or why it cannot be read. */
export type ParsedLine =
  | { readonly kind: "argv"; readonly argv: readonly string[] }
  | { readonly kind: "shell" }
  | { readonly kind: "invalid"; readonly reason: "unbalanced_quote" | "empty" };

/** Characters that only a shell understands, outside quotes. */
const SHELL_SYNTAX = /[|&;<>()`$%!*?[\]{}~#]/;
/** `NAME=value program`: a variable set for one command is the shell's syntax. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Splits a line the way a terminal does for plain commands: blanks separate arguments, single
 * quotes keep everything, double quotes keep everything but `\"` (a backslash is otherwise literal,
 * so a Windows path stays as written). Syntax only a shell reads, outside single quotes, sends the
 * line to the shell.
 */
export function parseCommandLine(line: string): ParsedLine {
  const argv: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && line.charAt(index + 1) === '"') {
        current += '"';
        index += 1;
      } else if (char === "$" || char === "`") return { kind: "shell" };
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    if (SHELL_SYNTAX.test(char)) {
      // A `!` or a `~` inside a word is only a character to a program, but not to a shell: keep it simple.
      return { kind: "shell" };
    }
    current += char;
    started = true;
  }
  if (quote !== null) return { kind: "invalid", reason: "unbalanced_quote" };
  if (started) argv.push(current);
  const [program] = argv;
  if (program === undefined) return { kind: "invalid", reason: "empty" };
  if (ASSIGNMENT.test(program)) return { kind: "shell" };
  return { kind: "argv", argv };
}

/** Names of environment variables that hold, or may hold, a secret. */
const SECRET_VARIABLE = new RegExp(
  [
    "token",
    "secret",
    "passw(?:or)?d",
    "credential",
    "api[_-]?key",
    "access[_-]?key",
    "private[_-]?key",
    "cookie",
    "signature",
    "session[_-]?(?:id|key|token)",
    "(?:^|[_-])auth(?:$|[_-])",
    "(?:^|[_-])key$",
    "(?:database|db|redis|mongo[a-z]*|postgres[a-z]*|mysql|amqp)[_-]?(?:url|uri)",
    "[_-]dsn$",
    "connection[_-]?string",
    "proxy",
    "(?:^|[_-])pat$",
    "pgpass",
    "git_config_(?:parameters|value|key)",
    "(?:^|[_-])ssh",
  ].join("|"),
  "i",
);

/** An address that carries its credentials: `scheme://user:password@host`. */
const CREDENTIALS_IN_ADDRESS = /:\/\/[^\s/:@]+:[^\s/@]+@/;

/**
 * True for a variable the engine does not hand to a command it runs: by its name, or by a value
 * that carries the credentials of an address.
 */
export function isSecretVariable(name: string, value?: string): boolean {
  return SECRET_VARIABLE.test(name) || (value !== undefined && CREDENTIALS_IN_ADDRESS.test(value));
}

/**
 * Where the id of a criterion goes in the line that runs the tests of a criterion:
 * `{criterion}` for `AC-17-3-2`, `{criterion_}` for `AC_17_3_2` where a name takes no dash. The
 * creator accepts the line with the marks in it; the engine writes the id, which is plain
 * characters (letters, digits, `-`, `_`), never anything a shell reads.
 */
const CRITERION_MARK = /\{criterion_?\}/g;

/** True when the line runs the tests of a criterion: it holds `{criterion}` or `{criterion_}`. */
export function runsCriteria(line: string): boolean {
  return line.search(CRITERION_MARK) !== -1;
}

/** The line with the id of the criterion written in place of its marks. */
export function lineForCriterion(line: string, id: string): string {
  return line.replace(CRITERION_MARK, (mark) =>
    mark === "{criterion_}" ? id.replaceAll("-", "_") : id,
  );
}

/**
 * A declared line as it will be started: the marks of a criterion are plain characters once the id
 * is written, so they do not make it a line for the shell.
 */
export function parseDeclaredLine(line: string): ParsedLine {
  return parseCommandLine(lineForCriterion(line, "AC-1-1-1"));
}
