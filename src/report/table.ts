import type { AuditResult, AuditRow } from '../types.js';
import type { Palette } from './color.js';

const ANSI_RE = /\u001B\[[0-9;]*m/g;

/** Visible width, ignoring the ANSI escapes we may have added. */
function width(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

function pad(s: string, to: number, align: 'left' | 'right' = 'left'): string {
  const gap = Math.max(0, to - width(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function formatDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '-';
}

function formatAge(row: AuditRow): string {
  if (row.ageDays === null) return '-';
  if (row.ageDays < 1) {
    const hours = Math.max(0, Math.round(row.ageDays * 24));
    return `${hours}h`;
  }
  return row.ageDays < 100 ? row.ageDays.toFixed(1) : String(Math.round(row.ageDays));
}

export interface TableOptions {
  palette: Palette;
  /** Show at most this many rows. */
  top?: number;
  /** Print every package, not just the ones that need attention. */
  all?: boolean;
}

const asIs = (s: string) => s;

function summary(result: AuditResult, c: Palette): string {
  const t = result.totals;
  const parts = [
    `${t.packages} packages (${t.direct} direct)`,
    t.young > 0
      ? c.red(`${t.young} younger than ${result.minAgeDays}d`)
      : c.green(`0 younger than ${result.minAgeDays}d`),
    t.deprecated > 0 ? c.yellow(`${t.deprecated} deprecated`) : '0 deprecated',
    `${t.withProvenance} with provenance`,
  ];
  if (t.unknown > 0) parts.push(c.dim(`${t.unknown} unknown`));
  return parts.join(' · ');
}

/**
 * Renders the default human report. Rows arrive sorted youngest-first from
 * `buildAudit`, so "the first lines" and "what to act on" are the same list.
 */
export function renderTable(result: AuditResult, options: TableOptions): string {
  const c = options.palette;
  const out: string[] = [];
  const dot = ' · ';

  const asOfLabel = result.asOf.slice(0, 10);
  out.push(
    `${c.bold('dep-cooldown')} ${c.dim(`${dot.trim()} ${result.format}${dot}${result.totals.packages} packages`)}`,
  );
  out.push(
    c.dim(
      `registry ${result.registry}${dot}threshold ${result.minAgeDays}d${dot}ages as of ${asOfLabel}` +
        (result.asOfExplicit ? ' (--as-of)' : ' (today)') +
        (result.offline ? `${dot}offline` : ''),
    ),
  );

  if (!result.asOfExplicit) {
    const modified = result.lockfileModified.slice(0, 10);
    if (modified !== asOfLabel) {
      out.push(
        c.dim(
          `hint: this lockfile was last written on ${modified}. Re-run with ` +
            `--as-of ${modified} to see what a cooldown would have blocked that day.`,
        ),
      );
    }
  }
  out.push('');

  const shown = options.all
    ? result.rows
    : result.rows.filter((r) => r.young || r.deprecated || r.ageDays === null);
  const rows = options.top ? shown.slice(0, options.top) : shown;

  if (rows.length === 0) {
    out.push(
      c.green(
        `OK - every resolved version is at least ${result.minAgeDays} day(s) old, none deprecated.`,
      ),
    );
    out.push('');
    out.push(summary(result, c));
    return `${out.join('\n')}\n`;
  }

  const header = ['PACKAGE', 'VERSION', 'PUBLISHED', 'AGE', 'DEP', 'PROV', 'FLAGS'];
  const body = rows.map((r) => [
    truncate(r.name, 38),
    truncate(r.version, 20),
    formatDate(r.published),
    formatAge(r),
    r.direct ? 'direct' : 'trans.',
    r.provenance === null ? '-' : r.provenance ? 'yes' : 'no',
    [r.young ? 'YOUNG' : '', r.deprecated ? 'DEPRECATED' : '', r.error ?? '']
      .filter(Boolean)
      .join(' '),
  ]);

  const widths = header.map((h, i) => Math.max(width(h), ...body.map((row) => width(row[i] ?? ''))));

  out.push(c.dim(header.map((h, i) => pad(h, widths[i]!, i === 3 ? 'right' : 'left')).join('  ')));

  for (const [i, cells] of body.entries()) {
    const r = rows[i]!;
    const tint = r.young ? c.red : r.deprecated ? c.yellow : r.ageDays === null ? c.dim : asIs;
    const line = cells
      .map((cell, j) => pad(cell, widths[j]!, j === 3 ? 'right' : 'left'))
      .join('  ')
      .trimEnd();
    out.push(tint(line));
  }

  if (!options.all && shown.length > rows.length) {
    out.push(c.dim(`... ${shown.length - rows.length} more (raise --top, or use --json)`));
  }
  if (!options.all) {
    const hidden = result.totals.packages - shown.length;
    if (hidden > 0) {
      out.push(c.dim(`${hidden} package(s) passed and are not listed; --all shows everything.`));
    }
  }

  out.push('');
  out.push(summary(result, c));
  return `${out.join('\n')}\n`;
}
