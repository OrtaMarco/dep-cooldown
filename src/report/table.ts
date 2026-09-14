import type { AuditResult, AuditRow, SkippedEntry } from '../types.js';
import type { Palette } from './color.js';
import { escapeControl } from './sanitize.js';

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

/** Text from the lockfile, the registry or the user, made safe for a terminal. */
const safe = escapeControl;

function formatDate(iso: string | null): string {
  return iso ? safe(iso.slice(0, 10)) : '-';
}

/** `value` cut (not rounded) to `places` decimals. */
function cutDecimals(value: number, places: number): string {
  const text = String(value);
  // String() switches to exponent notation below 1e-6; toFixed never does here.
  const [int = '0', frac = ''] = (text.includes('e') ? value.toFixed(12) : text).split('.');
  return places === 0 ? int : `${int}.${frac.slice(0, places).padEnd(places, '0')}`;
}

/**
 * Days as the audit computed them (already floored), with one decimal, or none
 * past 100 days — unless that would read at or above the threshold on a young
 * row, or below it on a passing one. Then it shows the places that tell them apart.
 */
function formatDays(days: number, minAgeDays: number, young: boolean): string {
  const text = String(days);
  const kept = text.includes('e') ? 12 : (text.split('.')[1] ?? '').length;
  const first = Math.abs(days) >= 100 ? 0 : 1;
  const last = Math.max(first, kept);
  let shown = cutDecimals(days, first);
  for (let places = first; places <= last; places++) {
    shown = cutDecimals(days, places);
    if (Number(shown) < minAgeDays === young) break;
  }
  return shown;
}

function formatAge(row: AuditRow, result: AuditResult): string {
  if (row.ageDays === null) return '-';
  // Under a day, hours — only when every sub-day age is below the threshold
  // anyway, so the hour figure cannot contradict the verdict.
  if (row.ageDays >= 0 && row.ageDays < 1 && result.minAgeDays >= 1 && row.published) {
    const hours = Math.floor((Date.parse(result.asOf) - Date.parse(row.published)) / 3_600_000);
    return `${Math.max(0, hours)}h`;
  }
  return formatDays(row.ageDays, result.minAgeDays, row.young);
}

const isFuture = (row: AuditRow) => row.ageDays !== null && row.ageDays < 0;

export interface TableOptions {
  palette: Palette;
  /** Show at most this many rows. */
  top?: number;
  /** Print every package, not just the ones that need attention. */
  all?: boolean;
  /** Filters the rows went through (`--only-direct`, `--prod`), named in the verdict. */
  filters?: string[];
}

const asIs = (s: string) => s;

const SKIP_LABEL: Record<SkippedEntry['reason'], string> = {
  git: 'git',
  file: 'file:',
  link: 'link:',
  workspace: 'workspace',
  tarball: 'tarball',
  other: 'other',
};

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
  if (t.unknown > 0) parts.push(c.yellow(`${t.unknown} unknown`));
  return parts.join(' · ');
}

/** `3 skipped (2 git, 1 file:)`, most frequent reason first. */
function skippedSummary(skipped: SkippedEntry[]): string {
  const counts = new Map<string, number>();
  for (const s of skipped) {
    const label = SKIP_LABEL[s.reason] ?? safe(String(s.reason));
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const reasons = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${n} ${label}`)
    .join(', ');
  return `${skipped.length} skipped (${reasons})`;
}

/**
 * The one-line verdict, worded for exactly what was checked. It only starts
 * with `OK` when every audited row has a date at or past the threshold, none
 * is deprecated and nothing in the lockfile was skipped.
 */
function verdict(result: AuditResult, options: TableOptions): string | null {
  const c = options.palette;
  const t = result.totals;
  const skipped = result.skipped.length;
  if (t.packages === 0) {
    return skipped === 0
      ? c.green('OK - the lockfile lists no registry dependencies, so there is nothing to check.')
      : c.yellow('Nothing was checked: every entry in the lockfile was skipped (see below).');
  }
  if (t.young > 0 || t.deprecated > 0 || t.unknown > 0) return null;

  const filtered = options.filters?.length ? ` (${options.filters.join(' ')})` : '';
  const which =
    t.packages === 1
      ? `the 1 audited package version${filtered} is`
      : `all ${t.packages} audited package versions${filtered} are`;
  const claim = `${which} at least ${result.minAgeDays} day(s) old as of ${safe(result.asOf.slice(0, 10))}, none deprecated`;
  return skipped === 0
    ? c.green(`OK - ${claim}.`)
    : c.yellow(`${claim[0]!.toUpperCase()}${claim.slice(1)}; the ${skipped} skipped entr${skipped === 1 ? 'y was' : 'ies were'} not checked.`);
}

/**
 * Renders the default human report. Rows arrive sorted youngest-first from
 * `buildAudit`, so "the first lines" and "what to act on" are the same list.
 */
export function renderTable(result: AuditResult, options: TableOptions): string {
  const c = options.palette;
  const out: string[] = [];
  const dot = ' · ';

  const asOfLabel = safe(result.asOf.slice(0, 10));
  out.push(
    `${c.bold('dep-cooldown')} ${c.dim(`${dot.trim()} ${safe(result.format)}${dot}${result.totals.packages} packages`)}`,
  );
  out.push(
    c.dim(
      `registry ${safe(result.registry)}${dot}threshold ${result.minAgeDays}d${dot}ages as of ${asOfLabel}` +
        (result.asOfExplicit ? ' (--as-of)' : ' (today)') +
        (result.offline ? `${dot}offline` : ''),
    ),
  );

  if (!result.asOfExplicit) {
    const modified = safe(result.lockfileModified.slice(0, 10));
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
  const verdictLine = verdict(result, options);

  if (rows.length > 0) {
    const header = ['PACKAGE', 'VERSION', 'PUBLISHED', 'AGE', 'DEP', 'PROV', 'FLAGS'];
    const body = rows.map((r) => [
      truncate(safe(r.name), 38),
      truncate(safe(r.version), 20),
      formatDate(r.published),
      formatAge(r, result),
      r.direct ? 'direct' : 'trans.',
      r.provenance === null ? '-' : r.provenance ? 'yes' : 'no',
      [
        r.young ? 'YOUNG' : '',
        isFuture(r) ? 'FUTURE' : '',
        r.deprecated ? 'DEPRECATED' : '',
        r.error ? safe(r.error) : '',
      ]
        .filter(Boolean)
        .join(' '),
    ]);

    const widths = header.map((h, i) =>
      Math.max(width(h), ...body.map((row) => width(row[i] ?? ''))),
    );

    out.push(
      c.dim(header.map((h, i) => pad(h, widths[i]!, i === 3 ? 'right' : 'left')).join('  ').trimEnd()),
    );

    for (const [i, cells] of body.entries()) {
      const r = rows[i]!;
      const tint = r.young ? c.red : r.deprecated ? c.yellow : r.ageDays === null ? c.dim : asIs;
      const line = cells
        .map((cell, j) => pad(cell, widths[j]!, j === 3 ? 'right' : 'left'))
        .join('  ')
        .trimEnd();
      out.push(tint(line));
    }

    if (shown.length > rows.length) {
      out.push(c.dim(`... ${shown.length - rows.length} more (raise --top, or use --json)`));
    }
    if (!options.all) {
      const hidden = result.totals.packages - shown.length;
      if (hidden > 0) {
        out.push(c.dim(`${hidden} package(s) passed and are not listed; --all shows everything.`));
      }
    }
    const future = result.rows.filter(isFuture).length;
    if (future > 0) {
      out.push(
        c.red(
          `${future} version(s) are dated after the reference date (${asOfLabel}): they did not ` +
            'exist yet on that day, so they count as young.',
        ),
      );
    }
  }

  if (verdictLine !== null && (rows.length === 0 || options.all)) {
    if (rows.length > 0) out.push('');
    out.push(verdictLine);
  }

  out.push('');
  out.push(summary(result, c));

  if (result.skipped.length > 0) {
    const line = `${skippedSummary(result.skipped)} - no registry publish date, not checked`;
    if (options.all) {
      out.push(c.yellow(`${line}:`));
      for (const s of result.skipped) {
        out.push(c.dim(`  ${safe(s.name)}  ${safe(s.spec)}  (${SKIP_LABEL[s.reason] ?? safe(String(s.reason))})`));
      }
    } else {
      out.push(c.yellow(`${line}; --all lists them.`));
    }
  }

  return `${out.join('\n')}\n`;
}
