/**
 * C0 controls, DEL and C1 controls. Lockfile names and versions, registry
 * error text, `.npmrc` URLs and paths all reach the terminal, and any of them
 * can carry `ESC [`, an OSC 8 hyperlink, `\r` or `BEL`.
 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

const hex = (ch: string) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;

/** Makes every control character visible as a literal `\xNN`, newlines included. */
export function escapeControl(value: string): string {
  return value.replace(CONTROL_RE, hex);
}

/**
 * Same, but keeps `\n` so a multi-line message still reads as lines. Every
 * other control character, `\r` included, is escaped: a line can be added,
 * never overwritten or styled.
 */
export function escapeControlKeepNewlines(value: string): string {
  return value.split('\n').map(escapeControl).join('\n');
}
