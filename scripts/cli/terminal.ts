/**
 * Output helpers for the DNS CLI.
 *
 * ANSI styling is applied only when the destination is an interactive terminal
 * and `NO_COLOR` is unset, so piped, redirected and CI output stays plain text
 * and diffable.
 */

/** The subset of a writable stream the CLI needs; tests substitute a buffer. */
export interface OutputStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

/** The pair of streams every command writes to. */
export interface OutputStreams {
  stdout: OutputStream;
  stderr: OutputStream;
}

/** Text decorators, each a no-op when color is disabled. */
export interface Styler {
  bold(value: string): string;
  dim(value: string): string;
  red(value: string): string;
  green(value: string): string;
  yellow(value: string): string;
}

const PLAIN: Styler = {
  bold: (value) => value,
  dim: (value) => value,
  red: (value) => value,
  green: (value) => value,
  yellow: (value) => value,
};

/** Control Sequence Introducer, built at runtime so no raw ESC byte is stored. */
const CSI = `${String.fromCharCode(27)}[`;

/** Wrap `value` in a Select Graphic Rendition pair. */
const sgr = (code: number, value: string): string =>
  `${CSI}${code}m${value}${CSI}0m`;

const COLORED: Styler = {
  bold: (value) => sgr(1, value),
  dim: (value) => sgr(2, value),
  red: (value) => sgr(31, value),
  green: (value) => sgr(32, value),
  yellow: (value) => sgr(33, value),
};

/**
 * True when styled output is appropriate for `stream`.
 *
 * `NO_COLOR` (https://no-color.org) and an explicit `--no-color` both win over
 * a TTY; a non-TTY destination is never styled.
 */
export function shouldUseColor(
  stream: OutputStream,
  env: Record<string, string | undefined>,
  disabled = false,
): boolean {
  if (disabled) return false;
  if (typeof env.NO_COLOR === "string" && env.NO_COLOR !== "") return false;
  return stream.isTTY === true;
}

/** Pick the decorator set matching `enabled`. */
export function createStyler(enabled: boolean): Styler {
  return enabled ? COLORED : PLAIN;
}

/** Line-oriented writer bound to a pair of streams. */
export class Terminal {
  readonly style: Styler;

  constructor(
    private readonly streams: OutputStreams,
    colorEnabled: boolean,
  ) {
    this.style = createStyler(colorEnabled);
  }

  /** Write one line to stdout. */
  out(line = ""): void {
    this.streams.stdout.write(`${line}\n`);
  }

  /** Write one line to stderr. */
  err(line = ""): void {
    this.streams.stderr.write(`${line}\n`);
  }
}
