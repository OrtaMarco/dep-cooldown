export interface Palette {
  red: (s: string) => string;
  yellow: (s: string) => string;
  green: (s: string) => string;
  cyan: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}

const identity = (s: string) => s;

export const noColor: Palette = {
  red: identity,
  yellow: identity,
  green: identity,
  cyan: identity,
  dim: identity,
  bold: identity,
};

const ESC = '\u001B[';
const wrap = (open: string) => (s: string) => `${ESC}${open}m${s}${ESC}0m`;

export const ansi: Palette = {
  red: wrap('31'),
  yellow: wrap('33'),
  green: wrap('32'),
  cyan: wrap('36'),
  dim: wrap('2'),
  bold: wrap('1'),
};

/**
 * Colour only when someone is actually looking: a TTY, no `NO_COLOR`, no
 * `--no-color`, and not a dumb terminal. `FORCE_COLOR` overrides the lot.
 */
export function pickPalette(opts: { noColor?: boolean; stream?: { isTTY?: boolean } }): Palette {
  if (opts.noColor) return noColor;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return ansi;
  if (process.env.NO_COLOR !== undefined) return noColor;
  if (process.env.TERM === 'dumb') return noColor;
  return opts.stream?.isTTY ? ansi : noColor;
}
